/**
 * Fill in historical transaction fees for a contract whose history was loaded without them
 * (`backfill-events --full`).
 *
 * Walks down from fee_backfill_state.low_block (where the live sync, which records fees, began)
 * to the creation block, a window of blocks at a time. For every block with transfers, mints or
 * burns it fetches the block's receipts (one eth_getBlockReceipts call, --parallel at a time) and
 * sets blocks.total_fees_native to the summed fees of the distinct transactions that moved the
 * token, the same rule the live sync uses. Days whose blocks are all done get their daily
 * metrics fee total from those blocks. Event rows keep tx_fee_native NULL.
 *
 * Each window is written in one transaction together with the new low_block, so the script can be
 * stopped (Ctrl-C / SIGTERM) and re-run at any time, alongside the indexer.
 *
 * Usage:
 *   ts-node src/indexer/backfill-receipt-fees.ts <contract-id> [--parallel 16] [--rps 200] [--window 2000]
 */
import dotenv from 'dotenv';
dotenv.config();

import { createAdapter, BlockchainAdapter } from './adapters';
import { query, queryOne, transaction, withDatabaseRetry, closePool } from '../db';
import { RateLimitService } from './rateLimit';
import { isShutdownRequested, requestShutdown } from './shutdown';
import { RESOLUTIONS } from '../types';
import { StatusLineReporter } from './statusLineReporter';

interface Options {
  parallel: number;
  rps: number;
  window: number;
}

const FETCH_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv: string[]): { contractId: string; options: Options } {
  const options: Options = { parallel: 16, rps: 200, window: 2000 };
  const flags: Record<string, keyof Options> = { '--parallel': 'parallel', '--rps': 'rps', '--window': 'window' };
  let contractId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags[arg]) {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${arg} needs a positive number`);
      options[flags[arg]] = value;
    } else if (arg === '--contract') {
      contractId = argv[++i];
    } else if (/^[0-9a-f-]{36}$/i.test(arg)) {
      contractId = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!contractId) throw new Error('Usage: backfill-receipt-fees.ts <contract-id> [--parallel 16] [--rps 200] [--window 2000]');
  return { contractId, options };
}

async function blockFees(adapter: BlockchainAdapter, block: number, txHashes: string[]): Promise<bigint> {
  for (let attempt = 1; ; attempt++) {
    try {
      const fees = await adapter.getBlockFees!(block);
      let total = 0n;
      for (const tx of txHashes) {
        const fee = fees.get(tx.toLowerCase());
        if (!fee) throw new Error(`block ${block} has no receipt for ${tx}`);
        total += BigInt(fee.feeNative);
      }
      return total;
    } catch (error) {
      if (attempt >= FETCH_ATTEMPTS || isShutdownRequested()) throw error;
      const delay = Math.min(60000, 2000 * 2 ** (attempt - 1));
      console.log(`  block ${block}: ${(error as Error).message.slice(0, 160)}; retry ${attempt} in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}

/** Run fn over items with at most `parallel` in flight, keeping results in order. */
async function mapParallel<T, R>(items: T[], parallel: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => {
    while (next < items.length && !isShutdownRequested()) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

function fmtDuration(seconds: number): string {
  if (!isFinite(seconds)) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

async function main() {
  const { contractId, options } = parseArgs(process.argv.slice(2));
  StatusLineReporter.getInstance().setQuiet(true);

  const onSignal = () => {
    if (isShutdownRequested()) process.exit(1);
    console.log('Shutdown requested; finishing the current window (signal again to exit now)');
    requestShutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const contract = await queryOne<{ ticker: string; chain_type: 'evm' | 'tron' | 'solana'; rpc_endpoint: string; rpc_endpoint_id: string; creation_block: string | null }>(
    `SELECT s.ticker, n.chain_type, re.url AS rpc_endpoint, re.id AS rpc_endpoint_id, c.creation_block
     FROM contracts c JOIN networks n ON n.id = c.network_id JOIN stablecoins s ON s.id = c.stablecoin_id
     JOIN rpc_endpoints re ON re.id = c.rpc_endpoint_id WHERE c.id = $1`,
    [contractId]
  );
  if (!contract) throw new Error(`Contract ${contractId} not found`);
  const state = await queryOne<{ low_block: string; target_block: string; status: string }>(
    'SELECT low_block, target_block, status FROM fee_backfill_state WHERE contract_id = $1',
    [contractId]
  );
  if (!state) throw new Error(`${contract.ticker}: no fee_backfill_state row; its fees are already complete`);
  const target = Number(state.target_block);
  let low = Number(state.low_block);
  if (low <= target) {
    console.log(`${contract.ticker}: fee backfill already complete`);
    return;
  }
  const eventsDone = await queryOne<{ status: string; low_block: string }>(
    'SELECT status, low_block FROM event_backfill_state WHERE contract_id = $1',
    [contractId]
  );
  if (!eventsDone || eventsDone.status !== 'complete') {
    throw new Error(`${contract.ticker}: the event backfill has not finished; run backfill-events --full first`);
  }

  const rateLimiter = new RateLimitService();
  const adapter = await createAdapter(contract.chain_type, contract.rpc_endpoint, {
    rateLimiter, endpointId: contract.rpc_endpoint_id, maxRequestsPerSecond: options.rps,
  });
  if (!adapter.getBlockFees) {
    await adapter.disconnect();
    await rateLimiter.close();
    throw new Error(`The ${contract.chain_type} adapter cannot fetch block receipts`);
  }

  await query(`UPDATE fee_backfill_state SET status = 'running', updated_at = NOW() WHERE contract_id = $1`, [contractId]);
  console.log(`${contract.ticker}: backfilling fees for blocks ${target.toLocaleString()}-${(low - 1).toLocaleString()}, ${options.parallel} blocks at a time`);

  const startedAt = Date.now();
  const startLow = low;
  let blocksDone = 0;
  let lastReport = 0;
  try {
    while (low > target && !isShutdownRequested()) {
      const from = Math.max(target, low - options.window);
      const to = low - 1;
      // The token-moving transactions of each active block in the window
      const active = await withDatabaseRetry('fee backfill planning', () => query<{ block_number: string; txs: string[]; day: string }>(
        `SELECT block_number, array_agg(DISTINCT tx_hash) AS txs, to_char(min(timestamp), 'YYYY-MM-DD') AS day
         FROM events WHERE contract_id = $1 AND block_number BETWEEN $2 AND $3 AND kind <> 'admin'
         GROUP BY block_number`,
        [contractId, from, to]
      ));
      const totals = await mapParallel(active, options.parallel, r => blockFees(adapter, Number(r.block_number), r.txs));
      if (isShutdownRequested()) break;

      await withDatabaseRetry(`fee write of blocks ${from}-${to}`, () => transaction(async (client) => {
        if (active.length > 0) {
          await client.query(
            `UPDATE blocks b SET total_fees_native = u.fee::numeric, updated_at = NOW()
             FROM unnest($2::bigint[], $3::text[]) AS u(bn, fee)
             WHERE b.contract_id = $1 AND b.block_number = u.bn`,
            [contractId, active.map(r => Number(r.block_number)), totals.map(t => t.toString())]
          );
        }
        // Days whose first event is now within the done range have all their blocks' fees
        await client.query(
          `UPDATE metrics m
           SET total_fees_native = (SELECT COALESCE(sum(total_fees_native), 0) FROM blocks
                                    WHERE contract_id = m.contract_id AND block_number BETWEEN m.start_block AND m.end_block),
               updated_at = NOW()
           WHERE m.contract_id = $1 AND m.resolution_seconds = $2 AND m.start_block >= $3 AND m.start_block < $4`,
          [contractId, RESOLUTIONS.DAY, from, low]
        );
        const moved = await client.query(
          `UPDATE fee_backfill_state
           SET low_block = $1, updated_at = NOW(),
               status = CASE WHEN $1 <= target_block THEN 'complete' ELSE status END,
               completed_at = CASE WHEN $1 <= target_block THEN NOW() ELSE completed_at END
           WHERE contract_id = $2 AND low_block = $3`,
          [from, contractId, low]
        );
        if (moved.rowCount !== 1) throw new Error(`fee_backfill_state is no longer at block ${low}; is another fee backfill running?`);
      }));
      low = from;
      blocksDone += active.length;

      if (Date.now() - lastReport > 30000 || low <= target) {
        lastReport = Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        const blocksPerSec = (startLow - low) / elapsed;
        const day = active.length > 0 ? active.reduce((a, r) => (r.day < a ? r.day : a), active[0].day) : '';
        console.log(
          `${contract.ticker}: block ${low.toLocaleString()} ${day} | ${blocksDone.toLocaleString()} active blocks, ` +
          `${(blocksDone / elapsed).toFixed(1)}/s | ${(low - target).toLocaleString()} blocks left, ~${fmtDuration((low - target) / blocksPerSec)}`
        );
      }
    }
    console.log(low <= target ? `${contract.ticker}: fee backfill complete` : `${contract.ticker}: stopped; resume later from block ${(low - 1).toLocaleString()}`);
  } finally {
    await adapter.disconnect();
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
