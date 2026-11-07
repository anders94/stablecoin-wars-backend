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
 * Each range is written in one transaction together with the new low_block, and inserts skip
 * events that are already stored, so the script can be stopped (Ctrl-C / SIGTERM) and re-run
 * at any time, alongside the indexer.
 *
 * Usage:
 *   ts-node src/indexer/backfill-events.ts [<contract-id>...] [--span 1000] [--parallel 4] [--rps 100]
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
import { ContractEvents } from '../types';

interface ContractConfig {
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

interface Options {
  span: number;
  parallel: number;
  rps: number;
}

interface FetchedRange {
  from: number;
  to: number;
  events: ContractEvents;
}

function parseArgs(argv: string[]): { contractIds: string[]; options: Options } {
  const options: Options = { span: 1000, parallel: 4, rps: 100 };
  const contractIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--span' || arg === '--parallel' || arg === '--rps') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${arg} needs a positive number`);
      }
      options[arg.slice(2) as keyof Options] = value;
    } else if (/^[0-9a-f-]{36}$/i.test(arg)) {
      contractIds.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { contractIds, options };
}

/**
 * Fill in timestamps (fetched without them) from the blocks table, asking the node only for
 * blocks the table has no timestamp for.
 */
async function fillTimestamps(adapter: BlockchainAdapter, contractId: string, events: ContractEvents): Promise<void> {
  const all = [...events.transfers, ...events.others];
  if (all.length === 0) {
    return;
  }
  const blockNumbers = [...new Set(all.map(e => e.blockNumber))];
  const rows = await query<{ block_number: string; epoch: number }>(
    `SELECT block_number, extract(epoch FROM timestamp)::double precision AS epoch
     FROM blocks
     WHERE contract_id = $1 AND block_number = ANY($2::bigint[]) AND timestamp IS NOT NULL`,
    [contractId, blockNumbers]
  );
  const timestamps = new Map(rows.map(r => [Number(r.block_number), Number(r.epoch)]));
  for (const blockNumber of blockNumbers) {
    if (!timestamps.has(blockNumber)) {
      timestamps.set(blockNumber, await adapter.getBlockTimestamp(blockNumber));
    }
  }
  for (const e of all) {
    e.timestamp = timestamps.get(e.blockNumber)!;
  }
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

  console.log(`${label}: backfilling events for blocks ${target.toLocaleString()}-${(low - 1).toLocaleString()}`);
  await query(`UPDATE event_backfill_state SET status = 'running', updated_at = NOW() WHERE contract_id = $1`, [contract.id]);

  // Ranges are fetched several at a time, highest first, and written strictly in that order
  let nextTo = low - 1;
  const startFetch = (): { from: number; to: number; promise: Promise<FetchedRange> } | null => {
    if (nextTo < target) {
      return null;
    }
    const to = nextTo;
    const from = Math.max(target, to - options.span + 1);
    nextTo = from - 1;
    const promise = (async () => {
      const events = await adapter.getContractEvents!(contract.contract_address, from, to, eventSet, { timestamps: false });
      await fillTimestamps(adapter, contract.id, events);
      return { from, to, events };
    })();
    promise.catch(() => {});
    return { from, to, promise };
  };

  const inFlight: NonNullable<ReturnType<typeof startFetch>>[] = [];
  const startedAt = Date.now();
  const startLow = low;
  let inserted = 0;
  let lastReport = 0;

  try {
    for (let i = 0; i < options.parallel; i++) {
      const next = startFetch();
      if (next) inFlight.push(next);
    }

    while (inFlight.length > 0) {
      const { from, to, events } = await inFlight.shift()!.promise;
      // Fetches cut short by a shutdown return partial data, so never write after one
      if (isShutdownRequested()) {
        console.log(`${label}: stopping; resume later from block ${(low - 1).toLocaleString()}`);
        return;
      }
      const next = startFetch();
      if (next) inFlight.push(next);

      const rows = buildEventRows({ ...splitTransfers(events.transfers), others: events.others });
      const count = await withDatabaseRetry(`backfill write of blocks ${from}-${to}`, () => transaction(async (client) => {
        const n = await insertEventRows(client, contract.id, rows);
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

      if (Date.now() - lastReport > 10000 || low <= target) {
        lastReport = Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        const done = startLow - low;
        const remaining = low - target;
        const etaHours = done > 0 ? (remaining / (done / elapsed)) / 3600 : 0;
        const earliest = rows.reduce((min, r) => Math.min(min, r.timestamp), Infinity);
        const latest = Number.isFinite(earliest) ? new Date(earliest * 1000).toISOString().slice(0, 10) : '';
        console.log(
          `${label}: block ${low.toLocaleString()} ${latest} | ${inserted.toLocaleString()} events ` +
          `(${Math.round(inserted / elapsed).toLocaleString()}/s) | ${remaining.toLocaleString()} blocks left, ~${etaHours.toFixed(1)}h`
        );
      }
    }
    console.log(`${label}: backfill complete`);
  } finally {
    // Let fetches still running finish before the adapter is disconnected
    await Promise.all(inFlight.map(f => f.promise.catch(() => {})));
    await adapter.disconnect();
  }
}

async function main() {
  const { contractIds, options } = parseArgs(process.argv.slice(2));

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

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
