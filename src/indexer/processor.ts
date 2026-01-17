import { PoolClient } from 'pg';
import { createAdapter, BlockchainAdapter } from './adapters';
import { transaction, queryOne, execute } from '../db';
import { Contract, Network, SyncState, RESOLUTIONS, TransferEvent } from '../types';
import { isShutdownRequested } from './worker';
import { RateLimitService } from './rateLimit';

// Number of blocks to process per batch
// Set to 500 to stay under most RPC providers' limits (typically 800-2000)
const BLOCKS_PER_BATCH = 500;

// Seconds in a day (for daily metrics)
const SECONDS_PER_DAY = 86400;

// Rate limiter singleton
const rateLimiter = new RateLimitService({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
});

interface ContractWithNetwork extends Contract {
  chain_type: 'evm' | 'tron' | 'solana';
  decimals: number;
  network_name: string;
  stablecoin_name: string;
  rpc_endpoint_id: string;
  rpc_endpoint: string;
  max_requests_per_minute: number;
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

export async function discoverContract(contractId: string): Promise<void> {
  // Get contract details
  const contract = await queryOne<ContractWithNetwork>(
    `SELECT c.*, n.chain_type, n.name as network_name, s.decimals, s.name as stablecoin_name,
            re.id as rpc_endpoint_id, re.url as rpc_endpoint, re.max_requests_per_minute
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

  console.log(`Discovering ${contract.stablecoin_name} on ${contract.network_name}...`);

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
      maxRequestsPerMinute: contract.max_requests_per_minute,
    });

    // Find contract creation block
    let creationBlock = contract.creation_block;

    if (!creationBlock) {
      console.log(`Finding creation block for ${contract.stablecoin_name} on ${contract.network_name}...`);
      creationBlock = await adapter.getContractCreationBlock(contract.contract_address);

      if (creationBlock) {
        // Get timestamp for creation block
        const timestamp = await adapter.getBlockTimestamp(creationBlock);
        const creationDate = new Date(timestamp * 1000);

        console.log(`  Found creation block: ${creationBlock.toLocaleString()} (${creationDate.toISOString()})`);

        // Update contract with creation info
        await execute(
          `UPDATE contracts SET creation_block = $1, creation_date = $2 WHERE id = $3`,
          [creationBlock, creationDate, contractId]
        );
      } else {
        // Use a fallback - try to get first Transfer event
        console.log('  Could not determine creation block, starting from block 1');
        creationBlock = 1;
      }
    } else {
      console.log(`  Using known creation block: ${creationBlock.toLocaleString()}`);
    }

    // Update sync state with starting block
    await execute(
      `UPDATE sync_state
       SET last_synced_block = $1, status = 'syncing', updated_at = NOW()
       WHERE contract_id = $2`,
      [creationBlock - 1, contractId]
    );

    console.log(`${contract.stablecoin_name} on ${contract.network_name} discovered. Creation block: ${creationBlock}`);

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
            re.id as rpc_endpoint_id, re.url as rpc_endpoint, re.max_requests_per_minute
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

  console.log(`Syncing ${contract.stablecoin_name} on ${contract.network_name}...`);

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
      maxRequestsPerMinute: contract.max_requests_per_minute,
    });

    const currentBlock = await adapter.getCurrentBlockNumber();
    // Ensure last_synced_block is a number (PostgreSQL may return as string)
    const lastSyncedBlock = Number(syncState.last_synced_block);
    let fromBlock = lastSyncedBlock + 1;

    const totalBlocks = currentBlock - fromBlock + 1;

    console.log(`  Current block: ${currentBlock.toLocaleString()}`);
    console.log(`  Last synced block: ${lastSyncedBlock.toLocaleString()}`);
    console.log(`  Next block to sync: ${fromBlock.toLocaleString()}`);
    console.log(`  Total blocks to process: ${totalBlocks.toLocaleString()}`);

    if (totalBlocks <= 0) {
      console.log(`${contract.stablecoin_name} on ${contract.network_name} is up to date (block ${currentBlock})`);

      // Make sure status is set to 'synced' if it was in another state
      if (syncState.status !== 'synced') {
        await execute(
          `UPDATE sync_state SET status = 'synced', updated_at = NOW() WHERE contract_id = $1`,
          [contractId]
        );
      }

      return;
    }

    console.log(`Syncing ${contract.stablecoin_name} on ${contract.network_name}: ${totalBlocks.toLocaleString()} blocks to process (${fromBlock} to ${currentBlock})`);

    let processedBlocks = 0;
    let totalTransfers = 0;
    let totalMints = 0;
    let totalBurns = 0;

    while (fromBlock <= currentBlock) {
      // Check for shutdown request
      if (isShutdownRequested()) {
        console.log(`Shutdown requested, stopping sync for ${contract.stablecoin_name} on ${contract.network_name} at block ${fromBlock}`);
        // Update sync state before exiting
        await execute(
          `UPDATE sync_state
           SET last_synced_block = $1, last_synced_at = NOW(), updated_at = NOW()
           WHERE contract_id = $2`,
          [fromBlock - 1, contractId]
        );
        return;
      }

      const toBlock = Math.min(fromBlock + BLOCKS_PER_BATCH - 1, currentBlock);
      processedBlocks += (toBlock - fromBlock + 1);

      const progress = ((processedBlocks / totalBlocks) * 100).toFixed(1);
      console.log(`[${progress}%] Processing blocks ${fromBlock.toLocaleString()} to ${toBlock.toLocaleString()}...`);

      // Get all transfer events in this range
      const transfers = await adapter.getTransferEvents(
        contract.contract_address,
        fromBlock,
        toBlock
      );

      // Get mint/burn events
      const { mints, burns } = await adapter.getMintBurnEvents(
        contract.contract_address,
        fromBlock,
        toBlock
      );

      totalTransfers += transfers.length;
      totalMints += mints.length;
      totalBurns += burns.length;

      if (transfers.length > 0 || mints.length > 0 || burns.length > 0) {
        console.log(`  Found ${transfers.length} transfers, ${mints.length} mints, ${burns.length} burns`);
      }

      // Process into daily metrics
      await processEvents(contractId, transfers, mints, burns, contract.decimals, adapter);

      // Update sync state
      await execute(
        `UPDATE sync_state
         SET last_synced_block = $1, last_synced_at = NOW(), updated_at = NOW()
         WHERE contract_id = $2`,
        [toBlock, contractId]
      );

      fromBlock = toBlock + 1;
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

    console.log(`${contract.stablecoin_name} on ${contract.network_name} synced successfully`);
    console.log(`  Processed ${processedBlocks.toLocaleString()} blocks, ${totalTransfers.toLocaleString()} transfers, ${totalMints.toLocaleString()} mints, ${totalBurns.toLocaleString()} burns`);
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

async function processEvents(
  contractId: string,
  transfers: TransferEvent[],
  mints: { blockNumber: number; txHash: string; to: string; value: string; timestamp: number }[],
  burns: { blockNumber: number; txHash: string; from: string; value: string; timestamp: number }[],
  _decimals: number,
  adapter: BlockchainAdapter
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
  const txHashes = new Set<string>();
  for (const transfer of transfers) {
    const daily = getOrCreateDaily(transfer.timestamp, transfer.blockNumber);
    daily.txCount++;
    daily.senders.add(transfer.from);
    daily.receivers.add(transfer.to);
    daily.totalTransferred += BigInt(transfer.value);
    txHashes.add(transfer.txHash);
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

  // Get transaction fees (batch)
  if (txHashes.size > 0) {
    const fees = await adapter.getTransactionFees(Array.from(txHashes));

    for (const transfer of transfers) {
      const fee = fees.get(transfer.txHash);
      if (fee) {
        const daily = getOrCreateDaily(transfer.timestamp, transfer.blockNumber);
        daily.totalFeesNative += BigInt(fee.feeNative);
      }
    }
  }

  // Upsert daily metrics to database
  for (const [_key, daily] of dailyMetrics) {
    await execute(
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
