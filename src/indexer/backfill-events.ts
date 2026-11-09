/**
 * Fill the events table for history that was indexed before event rows were stored.
 *
 * The live sync stores events from sync_state.events_from_block onwards. This walks backwards
 * from the block before that down to the contract's creation block, so recent history becomes
 * browsable first; event_backfill_state.low_block records how far it has got. Only logs are
 * fetched from the node: block timestamps come from the blocks table (falling back to the node
 * for blocks it has none for), and transaction fees are not fetched (tx_fee_native stays NULL).
 * Metrics and block summaries are not touched.
 *
 * Ranges are sized from blocks.tx_count so each eth_getLogs query stays under the node's
 * result cap: a node that recomputes receipts scans the whole range before rejecting an
 * over-cap query, so a rejected query costs as much as a successful one. Ranges are fetched
 * --parallel at a time and written strictly from the top down.
 *
 * Each range is written in one transaction together with the new low_block, and inserts skip
 * events that are already stored, so the script can be stopped (Ctrl-C / SIGTERM) and re-run
 * at any time, alongside the indexer.
 *
 * --full loads the whole history of a contract that was registered at the chain head (so has no
 * blocks or metrics below where its live sync began): besides events it writes block summaries
 * and daily metrics through the indexer's writeChunk. With no blocks table to plan from, ranges
 * are sized from the log density of recently fetched ranges, timestamps come with the logs, and
 * every log the contract emitted is fetched so topics outside the event set are counted and
 * reported. Fees are left for backfill-receipt-fees. When done it recounts the daily unique
 * senders and receivers exactly.
 *
 * Usage:
 *   ts-node src/indexer/backfill-events.ts [<contract-id>...] [--full] [--span 1000] [--parallel 16]
 *     [--max-logs 15000] [--rps 200]
 *   --span      largest block range per query (the node's eth_getLogs block-range limit)
 *   --max-logs  target events per query, below the node's result cap (default 15000; 12000 with --full)
 * With no contract ids, every active contract whose live sync has started storing events.
 */
import dotenv from 'dotenv';
dotenv.config();

import { createAdapter, BlockchainAdapter } from './adapters';
import { query, queryOne, transaction, withDatabaseRetry, closePool } from '../db';
import { RateLimitService } from './rateLimit';
import { getEventSet, EventSet } from './eventSets';
import { buildEventRows, insertEventRows, splitTransfers } from './eventRows';
import { isShutdownRequested, requestShutdown } from './shutdown';
import { ContractEvents, RESOLUTIONS } from '../types';
import { writeChunk, resolveSupplyAccounts } from './processor';
import { recountAllDailyUniques } from './recompute-daily-uniques';
import { StatusLineReporter } from './statusLineReporter';

export interface ContractConfig {
  id: string;
  contract_address: string;
  creation_block: string | null;
  event_set: string;
  chain_type: 'evm' | 'tron' | 'solana';
  network_name: string;
  ticker: string;
  rpc_endpoint_id: string;
  rpc_endpoint: string;
  events_from_block: string | null;
}

export interface Options {
  span: number;
  parallel: number;
  maxLogs: number;
  rps: number;
  full: boolean;
}

interface PlannedRange {
  from: number;
  to: number;
  expected: number;
  timestamps: Map<number, number>;
}

interface FetchedRange extends PlannedRange {
  events: ContractEvents;
}

const PLAN_WINDOW_BLOCKS = 50000;
const FETCH_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv: string[]): { contractIds: string[]; options: Options } {
  const options: Options = { span: 1000, parallel: 16, maxLogs: 0, rps: 200, full: false };
  const flags: Record<string, 'span' | 'parallel' | 'maxLogs' | 'rps'> = { '--span': 'span', '--parallel': 'parallel', '--max-logs': 'maxLogs', '--rps': 'rps' };
  const contractIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--full') {
      options.full = true;
    } else if (arg === '--contract') {
      contractIds.push(argv[++i]);
    } else if (flags[arg]) {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${arg} needs a positive number`);
      }
      options[flags[arg]] = value;
    } else if (/^[0-9a-f-]{36}$/i.test(arg)) {
      contractIds.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // --full sizes ranges from an estimate that lags behind the data, so it aims further below the
  // node's 20k-log cap
  if (!options.maxLogs) options.maxLogs = options.full ? 12000 : 15000;
  return { contractIds, options };
}

/**
 * Splits [target, top] into ranges, highest first, each expected to hold at most maxLogs events
 * (blocks.tx_count counts transfers, mints and burns; administrative logs add a few more, which
 * the margin below the node's cap absorbs). Reads the blocks table a window at a time and keeps
 * each block's timestamp for the range that contains it.
 */
export class RangePlanner {
  private rows: { block: number; events: number; epoch: number | null }[] = [];
  private next: number;

  constructor(private contractId: string, top: number, private target: number, private options: Options) {
    this.next = top;
  }

  private async loadWindow(): Promise<void> {
    const low = Math.max(this.target, this.next - PLAN_WINDOW_BLOCKS + 1);
    const rows = await withDatabaseRetry('backfill range planning', () => query<{ block_number: string; tx_count: number; epoch: number | null }>(
      `SELECT block_number, tx_count, extract(epoch FROM timestamp)::double precision AS epoch
       FROM blocks WHERE contract_id = $1 AND block_number BETWEEN $2 AND $3
       ORDER BY block_number DESC`,
      [this.contractId, low, this.next]
    ));
    const byBlock = new Map(rows.map(r => [Number(r.block_number), r]));
    // Every block in the window, highest first; blocks without a row count as empty
    for (let b = this.next; b >= low; b--) {
      const r = byBlock.get(b);
      this.rows.push({ block: b, events: r?.tx_count ?? 0, epoch: r?.epoch === null || r?.epoch === undefined ? null : Number(r.epoch) });
    }
    this.next = low - 1;
  }

  async nextRange(): Promise<PlannedRange | null> {
    if (this.rows.length === 0) {
      if (this.next < this.target) {
        return null;
      }
      await this.loadWindow();
    }
    const to = this.rows[0].block;
    let from = to;
    let expected = 0;
    const timestamps = new Map<number, number>();
    while (true) {
      if (this.rows.length === 0) {
        if (this.next < this.target) break;
        await this.loadWindow();
      }
      const row = this.rows[0];
      const span = to - row.block + 1;
      // Always take at least one block, then stop before exceeding the budget or the span
      if (span > 1 && (expected + row.events > this.options.maxLogs || span > this.options.span)) break;
      this.rows.shift();
      from = row.block;
      expected += row.events;
      if (row.epoch !== null && row.events > 0) timestamps.set(row.block, row.epoch);
    }
    return { from, to, expected, timestamps };
  }
}

interface Planner {
  nextRange(): Promise<PlannedRange | null>;
}

/**
 * Splits [target, top] into ranges, highest first, for a contract with no blocks table to plan
 * from. Each range is sized from the log density (logs per block, of every topic) of recently
 * fetched ranges so it holds about maxLogs logs. The estimate follows increases at once and decays
 * slowly, since an underestimate costs a rejected query and a bisection.
 */
export class DensityPlanner implements Planner {
  private next: number;
  private density: number | null = null;

  constructor(top: number, private target: number, private options: Options, private initialSpan = 100) {
    this.next = top;
  }

  observe(from: number, to: number, logs: number): void {
    const d = logs / (to - from + 1);
    this.density = this.density === null ? d : Math.max(d, 0.8 * this.density + 0.2 * d);
  }

  async nextRange(): Promise<PlannedRange | null> {
    if (this.next < this.target) return null;
    const span = this.density === null
      ? this.initialSpan
      : Math.max(1, Math.min(this.options.span, Math.floor(this.options.maxLogs / Math.max(this.density, 0.001))));
    const to = this.next;
    const from = Math.max(this.target, to - span + 1);
    this.next = from - 1;
    return { from, to, expected: Math.round((this.density ?? 0) * (to - from + 1)), timestamps: new Map() };
  }
}

const KNOWN_TOPICS: Record<string, string> = {
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925': 'Approval',
};

/** Fetch a range's logs, retrying transient node errors with backoff. */
export async function fetchRange(adapter: BlockchainAdapter, contract: ContractConfig, eventSet: EventSet, range: PlannedRange, full = false): Promise<FetchedRange> {
  for (let attempt = 1; ; attempt++) {
    try {
      const events = await adapter.getContractEvents!(contract.contract_address, range.from, range.to, eventSet, {
        timestamps: false, exactRange: true, lowercaseAddresses: true, allTopics: full,
      });
      await resolveSupplyAccounts(adapter, contract.contract_address, events.others);
      // Timestamps the node returned with the logs, else from the blocks table, else the node
      for (const e of [...events.transfers, ...events.others]) {
        if (e.timestamp > 0) continue;
        let ts = range.timestamps.get(e.blockNumber);
        if (ts === undefined) {
          ts = await adapter.getBlockTimestamp(e.blockNumber);
          range.timestamps.set(e.blockNumber, ts);
        }
        e.timestamp = ts;
      }
      return { ...range, events };
    } catch (error) {
      if (attempt >= FETCH_ATTEMPTS || isShutdownRequested()) throw error;
      const delay = Math.min(60000, 2000 * 2 ** (attempt - 1));
      console.log(`  blocks ${range.from}-${range.to}: ${(error as Error).message.slice(0, 160)}; retry ${attempt} in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

/** Events the metrics say exist below `block` (transfers only; mints and burns are few). */
async function remainingEvents(contractId: string, block: number): Promise<number> {
  const row = await queryOne<{ n: string | null }>(
    `SELECT sum(tx_count)::text AS n FROM metrics
     WHERE contract_id = $1 AND resolution_seconds = $2
       AND period_start < (SELECT date_trunc('day', timestamp) FROM blocks
                           WHERE contract_id = $1 AND block_number <= $3 AND timestamp IS NOT NULL
                           ORDER BY block_number DESC LIMIT 1)`,
    [contractId, RESOLUTIONS.DAY, block]
  );
  return Number(row?.n ?? 0);
}

function fmtDuration(seconds: number): string {
  if (!isFinite(seconds)) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

async function backfillContract(contract: ContractConfig, eventSet: EventSet, options: Options, rateLimiter: RateLimitService) {
  const label = `${contract.ticker} on ${contract.network_name}`;
  if (contract.events_from_block === null) {
    console.log(`${label}: live sync has not stored events yet; deploy the indexer with event storage first`);
    return;
  }
  if (contract.creation_block === null) {
    console.log(`${label}: creation block unknown; skipping`);
    return;
  }

  // Start (or resume) just below where the live sync began storing events
  await query(
    `INSERT INTO event_backfill_state (contract_id, low_block, target_block)
     VALUES ($1, $2, $3)
     ON CONFLICT (contract_id) DO NOTHING`,
    [contract.id, contract.events_from_block, contract.creation_block]
  );
  const state = await queryOne<{ low_block: string; target_block: string }>(
    'SELECT low_block, target_block FROM event_backfill_state WHERE contract_id = $1',
    [contract.id]
  );
  let low = Number(state!.low_block);
  const target = Number(state!.target_block);
  if (low <= target) {
    console.log(`${label}: backfill already complete`);
    return;
  }

  const adapter = await createAdapter(contract.chain_type, contract.rpc_endpoint, {
    rateLimiter,
    endpointId: contract.rpc_endpoint_id,
    maxRequestsPerSecond: options.rps,
  });
  if (!adapter.getContractEvents) {
    await adapter.disconnect();
    console.log(`${label}: the ${contract.chain_type} adapter cannot fetch events by range; skipping`);
    return;
  }

  if (options.full) {
    // Writing metrics for a range that already has them would count it twice
    const existing = await queryOne<{ block_number: string }>(
      'SELECT block_number FROM blocks WHERE contract_id = $1 AND block_number < $2 ORDER BY block_number DESC LIMIT 1',
      [contract.id, low]
    );
    if (existing) {
      await adapter.disconnect();
      throw new Error(`${label}: block summaries already exist below block ${low} (at ${existing.block_number}); --full is only for contracts registered at the chain head`);
    }
  }

  const totalRemaining = options.full ? 0 : await remainingEvents(contract.id, low);
  console.log(
    `${label}: backfilling ${options.full ? 'full history' : 'events'} for blocks ${target.toLocaleString()}-${(low - 1).toLocaleString()} ` +
    `${options.full ? '' : `(~${totalRemaining.toLocaleString()} events)`}, ${options.parallel} queries at a time, up to ${options.maxLogs} logs each`
  );
  await query(`UPDATE event_backfill_state SET status = 'running', updated_at = NOW() WHERE contract_id = $1`, [contract.id]);

  const densityPlanner = options.full ? new DensityPlanner(low - 1, target, options) : null;
  const planner: Planner = densityPlanner ?? new RangePlanner(contract.id, low - 1, target, options);
  const unknownTopics = new Map<string, number>();
  const reportUnknown = () => [...unknownTopics].map(([t, n]) => `${KNOWN_TOPICS[t] ?? t}: ${n.toLocaleString()}`).join(', ') || 'none';
  let planning: Promise<unknown> = Promise.resolve();
  // Ranges are planned in order (the planner is sequential) and fetched in parallel
  const startFetch = async (): Promise<FetchedRange | null> => {
    const planned = planning.then(() => planner.nextRange());
    planning = planned.catch(() => {});
    const range = await planned;
    if (!range) return null;
    const fetched = await fetchRange(adapter, contract, eventSet, range, options.full);
    const unknown = [...(fetched.events.unknownTopics ?? new Map<string, number>()).values()].reduce((a, b) => a + b, 0);
    densityPlanner?.observe(range.from, range.to, fetched.events.transfers.length + fetched.events.others.length + unknown);
    return fetched;
  };

  const inFlight: Promise<FetchedRange | null>[] = [];
  const startedAt = Date.now();
  const startLow = low;
  let inserted = 0;
  let lastReport = 0;

  try {
    for (let i = 0; i < options.parallel; i++) {
      const p = startFetch();
      p.catch(() => {});
      inFlight.push(p);
    }

    while (inFlight.length > 0) {
      const fetched = await inFlight.shift()!;
      if (!fetched) continue;
      // Fetches cut short by a shutdown return partial data, so never write after one
      if (isShutdownRequested()) {
        console.log(`${label}: stopping; resume later from block ${(low - 1).toLocaleString()}`);
        return;
      }
      const next = startFetch();
      next.catch(() => {});
      inFlight.push(next);

      const { from, to, events } = fetched;
      for (const [topic, n] of events.unknownTopics ?? []) unknownTopics.set(topic, (unknownTopics.get(topic) ?? 0) + n);
      const source = { ...splitTransfers(events.transfers, eventSet.transferToZeroBurns ?? true), others: events.others };
      const rows = buildEventRows(source);
      const count = await withDatabaseRetry(`backfill write of blocks ${from}-${to}`, () => transaction(async (client) => {
        let n: number;
        if (options.full) {
          // Events, block summaries and daily metrics; daily uniques are recounted at the end
          await writeChunk(client, contract.id, { ...source, fees: new Map() }, from, to, 'deferred');
          n = rows.length;
        } else {
          n = await insertEventRows(client, contract.id, rows);
        }
        const moved = await client.query(
          `UPDATE event_backfill_state
           SET low_block = $1, updated_at = NOW(),
               status = CASE WHEN $1 <= target_block THEN 'complete' ELSE status END,
               completed_at = CASE WHEN $1 <= target_block THEN NOW() ELSE completed_at END
           WHERE contract_id = $2 AND low_block = $3`,
          [from, contract.id, to + 1]
        );
        if (moved.rowCount !== 1) {
          throw new Error(`event_backfill_state for ${label} is no longer at block ${to + 1}; is another backfill running?`);
        }
        return n;
      }));
      low = from;
      inserted += count;

      if (Date.now() - lastReport > 30000 || low <= target) {
        lastReport = Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = inserted / elapsed;
        const earliest = rows.reduce((min, r) => Math.min(min, r.timestamp), Infinity);
        const day = Number.isFinite(earliest) ? new Date(earliest * 1000).toISOString().slice(0, 10) : '';
        const blocksPerSec = (startLow - low) / elapsed;
        const left = options.full
          ? `${(low - target).toLocaleString()} blocks left, ~${fmtDuration((low - target) / blocksPerSec)} | other topics: ${reportUnknown()}`
          : `~${Math.max(0, totalRemaining - inserted).toLocaleString()} events left, ~${fmtDuration(Math.max(0, totalRemaining - inserted) / rate)}`;
        console.log(
          `${label}: block ${low.toLocaleString()} ${day} | ${inserted.toLocaleString()} events, ` +
          `${Math.round(rate).toLocaleString()}/s, ${Math.round(blocksPerSec)} blocks/s | ${left}`
        );
      }
    }
    console.log(`${label}: backfill complete`);
    if (options.full) {
      console.log(`${label}: logs outside the event set: ${reportUnknown()}`);
      console.log(`${label}: recounting daily unique senders and receivers`);
      await recountAllDailyUniques(contract.id, (day, i, n) => {
        if (i % 100 === 0 || i === n) console.log(`  ${i}/${n} days (${day})`);
      });
    }
  } finally {
    // Let fetches still running finish before the adapter is disconnected
    await Promise.all(inFlight.map(f => f.catch(() => {})));
    await adapter.disconnect();
  }
}

async function main() {
  const { contractIds, options } = parseArgs(process.argv.slice(2));
  // writeChunk and the adapter report per-chunk progress for the live sync; this reports its own
  StatusLineReporter.getInstance().setQuiet(true);

  const onSignal = () => {
    if (isShutdownRequested()) {
      process.exit(1);
    }
    console.log('Shutdown requested; finishing the current write (signal again to exit now)');
    requestShutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const contracts = await query<ContractConfig>(
    `SELECT c.id, c.contract_address, c.creation_block, c.event_set, n.chain_type, n.name AS network_name,
            s.ticker, re.id AS rpc_endpoint_id, re.url AS rpc_endpoint, ss.events_from_block
     FROM contracts c
     JOIN networks n ON c.network_id = n.id
     JOIN stablecoins s ON c.stablecoin_id = s.id
     JOIN rpc_endpoints re ON c.rpc_endpoint_id = re.id
     LEFT JOIN sync_state ss ON ss.contract_id = c.id
     WHERE ${contractIds.length > 0 ? 'c.id = ANY($1::uuid[])' : 'c.is_active'}
     ORDER BY s.ticker, n.name`,
    contractIds.length > 0 ? [contractIds] : []
  );
  if (contractIds.length > 0 && contracts.length !== contractIds.length) {
    throw new Error('Some contract ids were not found');
  }

  const rateLimiter = new RateLimitService();
  try {
    for (const contract of contracts) {
      if (isShutdownRequested()) break;
      await backfillContract(contract, getEventSet(contract.event_set), options, rateLimiter);
    }
  } finally {
    await rateLimiter.close();
  }
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
