import { PoolClient } from 'pg';
import { createAdapter, BlockchainAdapter } from './adapters';
import { transaction, withDatabaseRetry, queryOne, execute } from '../db';
import { Contract, Network, SyncState, RESOLUTIONS, TransferEvent, ContractLogEvent, MintEvent, BurnEvent } from '../types';
import { getEventSet, EventSet } from './eventSets';
import { buildEventRows, insertEventRows, splitTransfers } from './eventRows';
import { isShutdownRequested } from './shutdown';
import { RateLimitService } from './rateLimit';
import { StatusLineReporter } from './statusLineReporter';

// Number of blocks to process per batch is now configured per RPC endpoint
// via the max_blocks_per_query field in the rpc_endpoints table
// Different RPC providers have different limits (e.g., QuickNode discover plan: 5 blocks, others: 2000+ blocks)

// Seconds in a day (for daily metrics)
const SECONDS_PER_DAY = 86400;

// Rate limiter singleton
const rateLimiter = new RateLimitService();

interface ContractWithNetwork extends Contract {
  chain_type: 'evm' | 'tron' | 'solana';
  decimals: number;
  network_name: string;
  stablecoin_name: string;
  rpc_endpoint_id: string;
  rpc_endpoint: string;
  max_requests_per_second: number;
  max_blocks_per_query: number;
  event_set: string;
}

interface DailyMetrics {
  date: Date;
  minted: bigint;
  burned: bigint;
  txCount: number;
  senders: Set<string>;
  receivers: Set<string>;
  totalTransferred: bigint;
  totalFeesNative: bigint;
  startBlock: number;
  endBlock: number;
}

type FeeMap = Map<string, { feeNative: string; feeUsd: string | null }>;

/**
 * Sum each transaction's fee once into the bucket its events fall in (a transaction is in a single
 * block, so in a single block and day). Transactions that only emitted administrative events are
 * not counted.
 */
function addDistinctTxFees<T>(
  events: { txHash: string }[],
  fees: FeeMap,
  bucketOf: (e: { txHash: string }) => T,
  add: (bucket: T, fee: bigint) => void
): void {
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.txHash)) continue;
    seen.add(e.txHash);
    const fee = fees.get(e.txHash);
    if (fee) add(bucketOf(e), BigInt(fee.feeNative));
  }
}

/** How writeChunk keeps the daily unique sender/receiver counts. */
export type UniquesMode =
  // Live sync: add the chunk's own distinct counts, and recount the touched days exactly from the
  // events table at most every UNIQUES_REFRESH_MS (and once more when a day has closed)
  | 'live'
  // Recount every touched day exactly now (reindexing whole days)
  | 'exact'
  // Only add the chunk's counts; the caller recounts afterwards (history backfill)
  | 'deferred';

const UNIQUES_REFRESH_MS = 10 * 60 * 1000;
// contract id -> day (YYYY-MM-DD) -> when it was last recounted
const uniquesRecountedAt = new Map<string, Map<string, number>>();
// contract id -> latest day seen by the live sync
const latestLiveDay = new Map<string, string>();

/**
 * Recount a day's unique senders and receivers exactly from the events table: senders are the
 * sources of transfers and burns, receivers the destinations of transfers and mints.
 */
export async function recountDailyUniques(client: PoolClient, contractId: string, day: string): Promise<void> {
  await client.query(
    `UPDATE metrics m
     SET unique_senders = u.senders, unique_receivers = u.receivers, updated_at = NOW()
     FROM (
       SELECT (COUNT(DISTINCT from_address) FILTER (WHERE kind IN ('transfer', 'burn')))::int AS senders,
              (COUNT(DISTINCT to_address) FILTER (WHERE kind IN ('transfer', 'mint')))::int AS receivers
       FROM events
       WHERE contract_id = $1 AND timestamp >= $2::date AND timestamp < $2::date + 1 AND kind <> 'admin'
     ) u
     WHERE m.contract_id = $1 AND m.period_start = $2::date AND m.resolution_seconds = $3`,
    [contractId, day, RESOLUTIONS.DAY]
  );
}

async function refreshDailyUniques(client: PoolClient, contractId: string, days: string[], mode: UniquesMode): Promise<void> {
  if (mode === 'deferred' || days.length === 0) return;
  const toRecount = new Set<string>();
  const now = Date.now();
  let recounted = uniquesRecountedAt.get(contractId);
  if (!recounted) {
    recounted = new Map();
    uniquesRecountedAt.set(contractId, recounted);
  }
  if (mode === 'exact') {
    days.forEach(d => toRecount.add(d));
  } else {
    for (const d of days) {
      if (now - (recounted.get(d) ?? 0) >= UNIQUES_REFRESH_MS) toRecount.add(d);
    }
    // Days run in order on the live sync, so a newer day means the previous one has closed:
    // give it a final exact count
    const newest = days.reduce((a, b) => (a > b ? a : b));
    const previous = latestLiveDay.get(contractId);
    if (previous && previous < newest) toRecount.add(previous);
    if (!previous || previous < newest) latestLiveDay.set(contractId, newest);
    // Only the newest day and the one before it can still be touched by the live sync
    const keepFrom = previous && previous < newest ? previous : newest;
    for (const d of [...recounted.keys()]) {
      if (d < keepFrom) recounted.delete(d);
    }
  }
  for (const d of toRecount) {
    await recountDailyUniques(client, contractId, d);
    recounted.set(d, now);
  }
}

/**
 * Fill in the account of supply events that implicitly credit or debit the contract owner (Tether's
 * Issue mints to, and Redeem burns from, whoever owns the contract at that block).
 */
export async function resolveSupplyAccounts(adapter: BlockchainAdapter, contractAddress: string, others: ContractLogEvent[]): Promise<void> {
  const unresolved = others.filter(e => (e.supply === 'mint' && !e.to) || (e.supply === 'burn' && !e.from));
  if (unresolved.length === 0 || !adapter.getOwnerAt) return;
  const owners = new Map<number, string | null>();
  for (const e of unresolved) {
    if (!owners.has(e.blockNumber)) {
      owners.set(e.blockNumber, await adapter.getOwnerAt(contractAddress, e.blockNumber));
    }
    const owner = owners.get(e.blockNumber) ?? null;
    if (e.supply === 'mint') e.to = owner; else e.from = owner;
  }
}

interface BlockData {
  blockNumber: number;
  timestamp: number;
  minted: bigint;
  burned: bigint;
  txCount: number;
  totalTransferred: bigint;
  totalFeesNative: bigint;
  totalSupply: string | null;
}

export async function discoverContract(contractId: string): Promise<void> {
  // Get contract details
  const contract = await queryOne<ContractWithNetwork>(
    `SELECT c.*, n.chain_type, n.name as network_name, s.decimals, s.name as stablecoin_name,
            re.id as rpc_endpoint_id, re.url as rpc_endpoint, re.max_requests_per_second, re.max_blocks_per_query
     FROM contracts c
     JOIN networks n ON c.network_id = n.id
     JOIN stablecoins s ON c.stablecoin_id = s.id
     JOIN rpc_endpoints re ON c.rpc_endpoint_id = re.id
     WHERE c.id = $1`,
    [contractId]
  );

  if (!contract) {
    throw new Error(`Contract ${contractId} not found`);
  }

  StatusLineReporter.getInstance().log(`Discovering ${contract.stablecoin_name} on ${contract.network_name}...`);

  // Update sync state to syncing
  await execute(
    `UPDATE sync_state SET status = 'syncing', updated_at = NOW() WHERE contract_id = $1`,
    [contractId]
  );

  let adapter: BlockchainAdapter | null = null;

  try {
    // Create adapter for chain type with rate limiting
    adapter = await createAdapter(contract.chain_type, contract.rpc_endpoint, {
      rateLimiter,
      endpointId: contract.rpc_endpoint_id,
      maxRequestsPerSecond: contract.max_requests_per_second,
    });

    // Find contract creation block
    let creationBlock = contract.creation_block;

    if (!creationBlock) {
      StatusLineReporter.getInstance().log(`Finding creation block for ${contract.stablecoin_name} on ${contract.network_name}...`);
      creationBlock = await adapter.getContractCreationBlock(contract.contract_address);

      if (!creationBlock) {
        throw new Error(
          `Failed to find creation block for ${contract.stablecoin_name} on ${contract.network_name}. ` +
          `Contract address: ${contract.contract_address}. ` +
          `Please manually set the creation_block in the database or verify the contract address is correct.`
        );
      }

      // Get timestamp for creation block
      const timestamp = await adapter.getBlockTimestamp(creationBlock);
      const creationDate = new Date(timestamp * 1000);

      StatusLineReporter.getInstance().log(`  Found creation block: ${creationBlock.toLocaleString()} (${creationDate.toISOString()})`);

      // Update contract with creation info
      await execute(
        `UPDATE contracts SET creation_block = $1, creation_date = $2 WHERE id = $3`,
        [creationBlock, creationDate, contractId]
      );
    } else {
      StatusLineReporter.getInstance().log(`  Using known creation block: ${creationBlock.toLocaleString()}`);
    }

    // Update sync state with starting block
    await execute(
      `UPDATE sync_state
       SET last_synced_block = $1, status = 'syncing', updated_at = NOW()
       WHERE contract_id = $2`,
      [creationBlock - 1, contractId]
    );

    StatusLineReporter.getInstance().log(`${contract.stablecoin_name} on ${contract.network_name} discovered. Creation block: ${creationBlock}`);

    // Start syncing
    await syncContract(contractId);
  } catch (error) {
    console.error(`Error discovering ${contract.stablecoin_name} on ${contract.network_name}:`, error);
    await execute(
      `UPDATE sync_state SET status = 'error', error_message = $1, updated_at = NOW() WHERE contract_id = $2`,
      [(error as Error).message, contractId]
    );
    throw error;
  } finally {
    if (adapter) {
      await adapter.disconnect();
    }
  }
}

export async function syncContract(contractId: string): Promise<void> {
  // Get contract details
  const contract = await queryOne<ContractWithNetwork>(
    `SELECT c.*, n.chain_type, n.name as network_name, s.decimals, s.name as stablecoin_name,
            re.id as rpc_endpoint_id, re.url as rpc_endpoint, re.max_requests_per_second, re.max_blocks_per_query
     FROM contracts c
     JOIN networks n ON c.network_id = n.id
     JOIN stablecoins s ON c.stablecoin_id = s.id
     JOIN rpc_endpoints re ON c.rpc_endpoint_id = re.id
     WHERE c.id = $1`,
    [contractId]
  );

  if (!contract) {
    throw new Error(`Contract ${contractId} not found`);
  }

  StatusLineReporter.getInstance().log(`Syncing ${contract.stablecoin_name} on ${contract.network_name}...`);

  // Get current sync state
  const syncState = await queryOne<SyncState>(
    'SELECT * FROM sync_state WHERE contract_id = $1',
    [contractId]
  );

  if (!syncState) {
    throw new Error(`Sync state for ${contract.stablecoin_name} on ${contract.network_name} not found`);
  }

  // Update status to syncing
  await execute(
    `UPDATE sync_state SET status = 'syncing', error_message = NULL, updated_at = NOW() WHERE contract_id = $1`,
    [contractId]
  );

  let adapter: BlockchainAdapter | null = null;

  try {
    // Create adapter for chain type with rate limiting
    adapter = await createAdapter(contract.chain_type, contract.rpc_endpoint, {
      rateLimiter,
      endpointId: contract.rpc_endpoint_id,
      maxRequestsPerSecond: contract.max_requests_per_second,
    });

    const currentBlock = await adapter.getCurrentBlockNumber();
    // Ensure last_synced_block is a number (PostgreSQL may return as string)
    const lastSyncedBlock = Number(syncState.last_synced_block);
    const fromBlock = lastSyncedBlock + 1;

    const totalBlocks = currentBlock - fromBlock + 1;

    StatusLineReporter.getInstance().log(`  Current block: ${currentBlock.toLocaleString()}`);
    StatusLineReporter.getInstance().log(`  Last synced block: ${lastSyncedBlock.toLocaleString()}`);
    StatusLineReporter.getInstance().log(`  Next block to sync: ${fromBlock.toLocaleString()}`);
    StatusLineReporter.getInstance().log(`  Total blocks to process: ${totalBlocks.toLocaleString()}`);

    if (totalBlocks <= 0) {
      StatusLineReporter.getInstance().log(`${contract.stablecoin_name} on ${contract.network_name} is up to date (block ${currentBlock})`);

      // Make sure status is set to 'synced' if it was in another state
      if (syncState.status !== 'synced') {
        await execute(
          `UPDATE sync_state SET status = 'synced', updated_at = NOW() WHERE contract_id = $1`,
          [contractId]
        );
      }

      return;
    }

    StatusLineReporter.getInstance().log(`Syncing ${contract.stablecoin_name} on ${contract.network_name}: ${totalBlocks.toLocaleString()} blocks to process (${fromBlock} to ${currentBlock})`);

    let processedBlocks = 0;
    let totalTransfers = 0;
    let totalMints = 0;
    let totalBurns = 0;

    // Start fetching a chunk from the node. Chunks are fetched one ahead, so the next chunk is
    // downloading while the current one is written to the database.
    const startFetch = (from: number) => {
      const to = Math.min(from + contract.max_blocks_per_query - 1, currentBlock);
      processedBlocks += (to - from + 1);
      const progress = ((processedBlocks / totalBlocks) * 100).toFixed(1);
      const chunk = (async () => {
        // Get block timestamp to show progress in time
        const blockTimestamp = await adapter!.getBlockTimestamp(to);
        const blockDateTime = new Date(blockTimestamp * 1000).toISOString().replace('T', ' ').substring(0, 16); // YYYY-MM-DD HH:MM format
        StatusLineReporter.getInstance().log(`[${progress}%] Processing blocks ${from.toLocaleString()} to ${to.toLocaleString()} (${blockDateTime})...`);
        return fetchChunk(adapter!, contract.contract_address, from, to, getEventSet(contract.event_set));
      })();
      // Awaited below; this only stops a failure from being reported as unhandled if the loop
      // exits before reaching it
      chunk.catch(() => {});
      return { fromBlock: from, toBlock: to, chunk };
    };

    let pending: ReturnType<typeof startFetch> | null = null;
    try {
      pending = startFetch(fromBlock);
      while (pending) {
        const { fromBlock, toBlock } = pending;
        const chunk = await pending.chunk;
        pending = null;

        // Fetches cut short by a shutdown return partial data, so check after the fetch and
        // never write a chunk once shutdown was requested.
        // No sync_state write needed: each committed chunk already recorded its progress
        if (isShutdownRequested()) {
          StatusLineReporter.getInstance().log(`Shutdown requested, stopping sync for ${contract.stablecoin_name} on ${contract.network_name} at block ${fromBlock}`);
          return;
        }

        if (toBlock < currentBlock) {
          pending = startFetch(toBlock + 1);
        }

        const { transfers, mints, burns } = chunk;
        totalTransfers += transfers.length;
        totalMints += mints.length;
        totalBurns += burns.length;

        // Write the chunk and advance sync_state atomically. The writes are additive, so a chunk
        // must never be applied twice: lock the sync_state row and only proceed if it still points
        // at the block just before this chunk. If another sync loop for this contract already moved
        // it (e.g. a timed-out job whose promise kept running), this loop stops instead.
        // If the database goes away mid-write the transaction rolls back, so wait for it to come
        // back and retry the write with the chunk already in memory.
        const applied = await withDatabaseRetry(`write of blocks ${fromBlock}-${toBlock}`, () => transaction(async (client) => {
          const state = await client.query<{ last_synced_block: string }>(
            'SELECT last_synced_block FROM sync_state WHERE contract_id = $1 FOR UPDATE',
            [contractId]
          );
          const lastSynced = Number(state.rows[0]?.last_synced_block);
          if (lastSynced === toBlock) {
            // Already written: the connection dropped after COMMIT reached the server but before
            // we saw the reply, and this is the retry
            return true;
          }
          if (lastSynced !== fromBlock - 1) {
            return false;
          }

          await writeChunk(client, contractId, chunk, fromBlock, toBlock);

          // The first chunk written with event rows marks where the event backfill must stop
          await client.query(
            `UPDATE sync_state
             SET last_synced_block = $1, last_synced_at = NOW(), updated_at = NOW(),
                 events_from_block = COALESCE(events_from_block, $3)
             WHERE contract_id = $2`,
            [toBlock, contractId, fromBlock]
          );
          return true;
        }));

        if (!applied) {
          StatusLineReporter.getInstance().log(`  sync_state for ${contract.stablecoin_name} on ${contract.network_name} moved past block ${fromBlock - 1} under another sync; stopping this one`);
          return;
        }
        StatusLineReporter.getInstance().log(`  Completed processing batch`);
      }
    } finally {
      // Let a prefetch that is still running finish before the adapter is disconnected
      if (pending) {
        await pending.chunk.catch(() => {});
      }
    }

    // Get final supply
    const totalSupply = await adapter.getTotalSupply(contract.contract_address);

    // Update latest metrics with current supply
    await execute(
      `UPDATE metrics
       SET total_supply = $1, updated_at = NOW()
       WHERE contract_id = $2
         AND resolution_seconds = $3
         AND period_start = (
           SELECT MAX(period_start) FROM metrics
           WHERE contract_id = $2 AND resolution_seconds = $3
         )`,
      [totalSupply, contractId, RESOLUTIONS.DAY]
    );

    // Mark as synced
    await execute(
      `UPDATE sync_state SET status = 'synced', updated_at = NOW() WHERE contract_id = $1`,
      [contractId]
    );

    StatusLineReporter.getInstance().log(`${contract.stablecoin_name} on ${contract.network_name} synced successfully`);
    StatusLineReporter.getInstance().log(`  Processed ${processedBlocks.toLocaleString()} blocks, ${totalTransfers.toLocaleString()} transfers, ${totalMints.toLocaleString()} mints, ${totalBurns.toLocaleString()} burns`);
  } catch (error) {
    console.error(`Error syncing ${contract.stablecoin_name} on ${contract.network_name}:`, error);
    await execute(
      `UPDATE sync_state SET status = 'error', error_message = $1, updated_at = NOW() WHERE contract_id = $2`,
      [(error as Error).message, contractId]
    );
    throw error;
  } finally {
    if (adapter) {
      await adapter.disconnect();
    }
  }
}

export interface ChunkData {
  transfers: TransferEvent[];
  // Mints and burns split out of zero-address Transfers
  mints: MintEvent[];
  burns: BurnEvent[];
  // The contract's other logs (administrative events, and supply events without a Transfer)
  others: ContractLogEvent[];
  fees: Map<string, { feeNative: string; feeUsd: string | null }>;
}

/**
 * Fetch everything needed to index a block range: transfer events (split into plain
 * transfers, mints and burns), the event set's other logs, and the fee for every
 * transaction involved.
 */
export async function fetchChunk(
  adapter: BlockchainAdapter,
  contractAddress: string,
  fromBlock: number,
  toBlock: number,
  eventSet: EventSet = getEventSet('erc20')
): Promise<ChunkData> {
  let allTransfers: TransferEvent[];
  let others: ContractLogEvent[] = [];
  if (adapter.getContractEvents) {
    ({ transfers: allTransfers, others } = await adapter.getContractEvents(contractAddress, fromBlock, toBlock, eventSet));
    await resolveSupplyAccounts(adapter, contractAddress, others);
  } else {
    allTransfers = await adapter.getTransferEvents(contractAddress, fromBlock, toBlock);
  }

  const { transfers, mints, burns } = splitTransfers(allTransfers, eventSet.transferToZeroBurns ?? true);

  if (transfers.length > 0 || mints.length > 0 || burns.length > 0 || others.length > 0) {
    StatusLineReporter.getInstance().log(`  Found ${transfers.length} transfers, ${mints.length} mints, ${burns.length} burns, ${others.length} other events`);
  }

  // Fetch fees once for every tx in the chunk; metrics, block summaries and events use them
  const txHashes = new Set([...allTransfers, ...others].map(t => t.txHash));
  const blockNumbers = new Set([...allTransfers, ...others].map(t => t.blockNumber));
  let fees = new Map<string, { feeNative: string; feeUsd: string | null }>();
  if (txHashes.size > 0) {
    StatusLineReporter.getInstance().log(`  Getting fees for ${txHashes.size} transactions in ${blockNumbers.size} blocks...`);
    fees = await adapter.getTransactionFees(Array.from(txHashes), Array.from(blockNumbers));
  }

  return { transfers, mints, burns, others, fees };
}

/**
 * Add a fetched chunk to the daily metrics, block summaries and events. Block summaries are
 * replaced and events are deduplicated, but the daily metrics are additive (a day spans many
 * chunks), so the caller must make sure a range is never applied twice (run inside a
 * transaction that also records the range as done, or that first deletes the range's rows).
 * Daily unique sender/receiver counts are kept according to `uniques` (see UniquesMode).
 */
export async function writeChunk(
  client: PoolClient,
  contractId: string,
  chunk: ChunkData,
  fromBlock: number,
  toBlock: number,
  uniques: UniquesMode = 'live'
): Promise<void> {
  const { transfers, fees } = chunk;

  // Supply events without a zero-address Transfer (e.g. Tether's Issue/Redeem) count as mints/burns
  const mints: MintEvent[] = [...chunk.mints];
  const burns: BurnEvent[] = [...chunk.burns];
  for (const e of chunk.others) {
    if (e.supply === 'mint') {
      mints.push({ blockNumber: e.blockNumber, logIndex: e.logIndex, txHash: e.txHash, to: e.to ?? '', value: e.amount ?? '0', timestamp: e.timestamp });
    } else if (e.supply === 'burn') {
      burns.push({ blockNumber: e.blockNumber, logIndex: e.logIndex, txHash: e.txHash, from: e.from ?? '', value: e.amount ?? '0', timestamp: e.timestamp });
    }
  }

  StatusLineReporter.getInstance().log(`  Processing events into daily metrics...`);
  await processEvents(client, contractId, transfers, mints, burns, fees);

  // Block summaries include blocks with no activity
  StatusLineReporter.getInstance().log(`  Processing block summaries...`);
  await processBlockSummaries(client, contractId, transfers, mints, burns, fees, fromBlock, toBlock);

  // Every individual event
  const rows = buildEventRows(chunk, fees);
  await insertEventRows(client, contractId, rows);

  // Exact daily unique counts come from the events just stored
  const days = [...new Set(rows.filter(r => r.kind !== 'admin').map(r => new Date(r.timestamp * 1000).toISOString().slice(0, 10)))];
  await refreshDailyUniques(client, contractId, days, uniques);
}

async function processEvents(
  client: PoolClient,
  contractId: string,
  transfers: TransferEvent[],
  mints: { blockNumber: number; txHash: string; to: string; value: string; timestamp: number }[],
  burns: { blockNumber: number; txHash: string; from: string; value: string; timestamp: number }[],
  fees: Map<string, { feeNative: string; feeUsd: string | null }>
): Promise<void> {
  if (transfers.length === 0 && mints.length === 0 && burns.length === 0) {
    return;
  }

  // Group events by day
  const dailyMetrics = new Map<string, DailyMetrics>();

  const getDateKey = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString().split('T')[0];
  };

  const getOrCreateDaily = (timestamp: number, blockNumber: number): DailyMetrics => {
    const key = getDateKey(timestamp);
    if (!dailyMetrics.has(key)) {
      const date = new Date(timestamp * 1000);
      date.setUTCHours(0, 0, 0, 0);
      dailyMetrics.set(key, {
        date,
        minted: BigInt(0),
        burned: BigInt(0),
        txCount: 0,
        senders: new Set(),
        receivers: new Set(),
        totalTransferred: BigInt(0),
        totalFeesNative: BigInt(0),
        startBlock: blockNumber,
        endBlock: blockNumber,
      });
    }
    const daily = dailyMetrics.get(key)!;
    daily.startBlock = Math.min(daily.startBlock, blockNumber);
    daily.endBlock = Math.max(daily.endBlock, blockNumber);
    return daily;
  };

  // Process transfers
  for (const transfer of transfers) {
    const daily = getOrCreateDaily(transfer.timestamp, transfer.blockNumber);
    daily.txCount++;
    daily.senders.add(transfer.from);
    daily.receivers.add(transfer.to);
    daily.totalTransferred += BigInt(transfer.value);
  }

  // Process mints
  for (const mint of mints) {
    const daily = getOrCreateDaily(mint.timestamp, mint.blockNumber);
    daily.minted += BigInt(mint.value);
  }

  // Process burns
  for (const burn of burns) {
    const daily = getOrCreateDaily(burn.timestamp, burn.blockNumber);
    daily.burned += BigInt(burn.value);
  }

  // Transaction fees, once per transaction
  const byTx = new Map<string, { timestamp: number; blockNumber: number }>();
  for (const e of [...transfers, ...mints, ...burns]) byTx.set(e.txHash, e);
  addDistinctTxFees(
    [...byTx.keys()].map(txHash => ({ txHash })),
    fees,
    e => byTx.get(e.txHash)!,
    (e, fee) => { getOrCreateDaily(e.timestamp, e.blockNumber).totalFeesNative += fee; }
  );

  // Upsert daily metrics to database
  for (const [_key, daily] of dailyMetrics) {
    await client.query(
      `INSERT INTO metrics (
        contract_id, period_start, resolution_seconds,
        minted, burned, tx_count, unique_senders, unique_receivers,
        total_transferred, total_fees_native, start_block, end_block
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (contract_id, period_start, resolution_seconds)
      DO UPDATE SET
        minted = metrics.minted + EXCLUDED.minted,
        burned = metrics.burned + EXCLUDED.burned,
        tx_count = metrics.tx_count + EXCLUDED.tx_count,
        unique_senders = metrics.unique_senders + EXCLUDED.unique_senders,
        unique_receivers = metrics.unique_receivers + EXCLUDED.unique_receivers,
        total_transferred = metrics.total_transferred + EXCLUDED.total_transferred,
        total_fees_native = metrics.total_fees_native + EXCLUDED.total_fees_native,
        start_block = LEAST(metrics.start_block, EXCLUDED.start_block),
        end_block = GREATEST(metrics.end_block, EXCLUDED.end_block),
        updated_at = NOW()`,
      [
        contractId,
        daily.date,
        RESOLUTIONS.DAY,
        daily.minted.toString(),
        daily.burned.toString(),
        daily.txCount,
        daily.senders.size,
        daily.receivers.size,
        daily.totalTransferred.toString(),
        daily.totalFeesNative.toString(),
        daily.startBlock,
        daily.endBlock,
      ]
    );
  }
}

async function processBlockSummaries(
  client: PoolClient,
  contractId: string,
  transfers: TransferEvent[],
  mints: { blockNumber: number; txHash: string; to: string; value: string; timestamp: number }[],
  burns: { blockNumber: number; txHash: string; from: string; value: string; timestamp: number }[],
  fees: FeeMap,
  fromBlock: number,
  toBlock: number
): Promise<void> {
  // Create entries for ALL blocks in range, not just those with activity
  const blocks = new Map<number, BlockData>();

  // Initialize all blocks in range with zero values
  // Timestamp will be null for blocks without events, and populated from events for blocks with activity
  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    blocks.set(blockNum, {
      blockNumber: blockNum,
      timestamp: 0, // Will be set from events, or left as 0 (converted to NULL in DB)
      minted: BigInt(0),
      burned: BigInt(0),
      txCount: 0,
      totalTransferred: BigInt(0),
      totalFeesNative: BigInt(0),
      totalSupply: null,
    });
  }

  const getOrCreateBlock = (blockNumber: number, timestamp: number): BlockData => {
    const block = blocks.get(blockNumber)!;
    // Set accurate timestamp from event
    block.timestamp = timestamp;
    return block;
  };

  // Process transfers
  for (const transfer of transfers) {
    const block = getOrCreateBlock(transfer.blockNumber, transfer.timestamp);
    block.txCount++;
    block.totalTransferred += BigInt(transfer.value);
  }

  // Process mints
  for (const mint of mints) {
    const block = getOrCreateBlock(mint.blockNumber, mint.timestamp);
    block.minted += BigInt(mint.value);
    block.txCount++;
  }

  // Process burns
  for (const burn of burns) {
    const block = getOrCreateBlock(burn.blockNumber, burn.timestamp);
    block.burned += BigInt(burn.value);
    block.txCount++;
  }

  // Transaction fees, once per transaction
  const blockOfTx = new Map<string, { blockNumber: number; timestamp: number }>();
  for (const e of [...transfers, ...mints, ...burns]) blockOfTx.set(e.txHash, e);
  addDistinctTxFees(
    [...blockOfTx.keys()].map(txHash => ({ txHash })),
    fees,
    e => blockOfTx.get(e.txHash)!,
    (e, fee) => { getOrCreateBlock(e.blockNumber, e.timestamp).totalFeesNative += fee; }
  );

  // Insert or replace every block in one statement. A chunk always holds every event of each of
  // its blocks, so the fresh values are complete; replacing (not adding) keeps a re-processed
  // range from double-counting. Blocks without events get a NULL timestamp, keeping any known one.
  // Per-address detail lives in the events table.
  const rows = [...blocks.values()];
  await client.query(
    `INSERT INTO blocks (
       contract_id, block_number, timestamp,
       minted, burned, tx_count, total_transferred, total_fees_native, total_supply
     )
     SELECT $1, bn, CASE WHEN ts > 0 THEN to_timestamp(ts) AT TIME ZONE 'UTC' END,
            minted::numeric, burned::numeric, n, moved::numeric, fees::numeric, NULL
     FROM unnest($2::bigint[], $3::double precision[], $4::text[], $5::text[], $6::integer[], $7::text[], $8::text[])
       AS u(bn, ts, minted, burned, n, moved, fees)
     ON CONFLICT (contract_id, block_number)
     DO UPDATE SET
       timestamp = COALESCE(EXCLUDED.timestamp, blocks.timestamp),
       minted = EXCLUDED.minted,
       burned = EXCLUDED.burned,
       tx_count = EXCLUDED.tx_count,
       total_transferred = EXCLUDED.total_transferred,
       total_fees_native = EXCLUDED.total_fees_native,
       updated_at = NOW()`,
    [
      contractId,
      rows.map(b => b.blockNumber),
      rows.map(b => b.timestamp),
      rows.map(b => b.minted.toString()),
      rows.map(b => b.burned.toString()),
      rows.map(b => b.txCount),
      rows.map(b => b.totalTransferred.toString()),
      rows.map(b => b.totalFeesNative.toString()),
    ]
  );
}
