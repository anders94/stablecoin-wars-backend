import dotenv from 'dotenv';
dotenv.config();

import { getIndexerQueue, closeQueue } from './queue';
import { discoverContract, syncContract } from './processor';
import { aggregateMetrics, runFullAggregation } from './aggregator';
import { closePool } from '../db';

// Import adapters to register them
import './adapters';

// Global shutdown flag
let isShuttingDown = false;

export function isShutdownRequested(): boolean {
  return isShuttingDown;
}

async function main() {
  console.log('Starting Stablecoin Wars Indexer Worker...');

  const queue = getIndexerQueue();

  // Keep queue paused during initialization to prevent race conditions
  await queue.pause(true); // Pause both locally and globally
  console.log('Queue paused for initialization');

  // Process discover-contract jobs
  queue.process('discover-contract', async (job) => {
    const { queryOne } = await import('../db');
    const contract = await queryOne<{ network_name: string; stablecoin_name: string }>(
      `SELECT n.name as network_name, s.name as stablecoin_name
       FROM contracts c
       JOIN networks n ON c.network_id = n.id
       JOIN stablecoins s ON c.stablecoin_id = s.id
       WHERE c.id = $1`,
      [job.data.contractId]
    );
    console.log(`Processing discover-contract job for ${contract?.stablecoin_name || 'unknown'} on ${contract?.network_name || 'unknown'}`);
    await discoverContract(job.data.contractId);
    return { success: true };
  });

  // Process sync-contract jobs
  queue.process('sync-contract', async (job) => {
    const { queryOne } = await import('../db');
    const contract = await queryOne<{ network_name: string; stablecoin_name: string }>(
      `SELECT n.name as network_name, s.name as stablecoin_name
       FROM contracts c
       JOIN networks n ON c.network_id = n.id
       JOIN stablecoins s ON c.stablecoin_id = s.id
       WHERE c.id = $1`,
      [job.data.contractId]
    );
    console.log(`Processing sync-contract job for ${contract?.stablecoin_name || 'unknown'} on ${contract?.network_name || 'unknown'}`);
    await syncContract(job.data.contractId);
    return { success: true };
  });

  // Process aggregate-metrics jobs
  queue.process('aggregate-metrics', async (job) => {
    console.log(`Processing aggregate-metrics job`);
    if (job.data.contractId) {
      await aggregateMetrics(job.data.contractId);
    } else {
      await runFullAggregation();
    }
    return { success: true };
  });

  // Event handlers
  queue.on('active', (job) => {
    console.log(`Job ${job.id} (${job.name}) started processing`);
  });

  queue.on('completed', (job, result) => {
    console.log(`Job ${job.id} (${job.name}) completed:`, result);
  });

  queue.on('failed', (job, err) => {
    console.error(`Job ${job?.id} (${job?.name}) failed:`, err);
  });

  queue.on('error', (err) => {
    console.error('Queue error:', err);
  });

  queue.on('stalled', (job) => {
    console.warn(`Job ${job?.id} (${job?.name}) has stalled`);
  });

  // Initialize: discover and sync all contracts
  async function initializeContracts() {
    console.log('Initializing contracts...');

    // Clean up any stuck or stalled jobs from previous runs
    const activeJobs = await queue.getActive();
    const waitingJobs = await queue.getWaiting();
    const delayedJobs = await queue.getDelayed();

    console.log(`Queue status: ${activeJobs.length} active, ${waitingJobs.length} waiting, ${delayedJobs.length} delayed`);

    // Remove stuck active jobs (from crashed previous runs)
    for (const job of activeJobs) {
      console.log(`  Cleaning up stuck active job: ${job.id} (${job.name})`);
      await job.moveToFailed({ message: 'Job stuck from previous run, cleaned up on restart' }, true);
    }

    const { query } = await import('../db');

    // Find all pending contracts (never been synced)
    const pendingContracts = await query<{ id: string; network_name: string; stablecoin_name: string }>(
      `SELECT c.id, n.name as network_name, s.name as stablecoin_name
       FROM contracts c
       JOIN networks n ON c.network_id = n.id
       JOIN stablecoins s ON c.stablecoin_id = s.id
       JOIN sync_state ss ON c.id = ss.contract_id
       WHERE c.is_active = true AND ss.status = 'pending'`
    );

    if (pendingContracts.length > 0) {
      console.log(`Found ${pendingContracts.length} contracts to discover and sync`);
      for (const contract of pendingContracts) {
        console.log(`  Queueing discovery for ${contract.stablecoin_name} on ${contract.network_name}`);
        const jobId = `discover-${contract.id}`;

        // Remove existing job if it exists and is not active
        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state !== 'active') {
            console.log(`    Removing existing job ${jobId} (state: ${state})`);
            await existingJob.remove();
          } else {
            console.log(`    Skipping removal of active job ${jobId}`);
          }
        }

        await queue.add('discover-contract', {
          contractId: contract.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          jobId,
        });
      }
    }

    // Find all contracts that need to catch up or retry
    // This includes: synced (ready to catch up), syncing (stuck/retry), error (retry)
    const activeContracts = await query<{ id: string; network_name: string; stablecoin_name: string; status: string }>(
      `SELECT c.id, n.name as network_name, s.name as stablecoin_name, ss.status
       FROM contracts c
       JOIN networks n ON c.network_id = n.id
       JOIN stablecoins s ON c.stablecoin_id = s.id
       JOIN sync_state ss ON c.id = ss.contract_id
       WHERE c.is_active = true AND ss.status IN ('synced', 'syncing', 'error')`
    );

    if (activeContracts.length > 0) {
      console.log(`Found ${activeContracts.length} contracts to sync`);
      for (const contract of activeContracts) {
        console.log(`  Queueing sync for ${contract.stablecoin_name} on ${contract.network_name} (status: ${contract.status})`);
        const jobId = `sync-${contract.id}`;

        // Remove existing job if it exists and is not active
        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state !== 'active') {
            console.log(`    Removing existing job ${jobId} (state: ${state})`);
            await existingJob.remove();
          } else {
            console.log(`    Skipping removal of active job ${jobId}`);
          }
        }

        await queue.add('sync-contract', {
          contractId: contract.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          jobId,
        });
      }
    }

    if (pendingContracts.length === 0 && activeContracts.length === 0) {
      console.log('No contracts found to sync');
    }

    console.log('Initialization complete');
  }

  // Run initialization
  await initializeContracts();

  // Resume queue after initialization
  await queue.resume(true); // Resume both locally and globally
  console.log('Queue resumed and ready to process jobs');

  // Schedule periodic aggregation
  const AGGREGATION_INTERVAL = 60 * 60 * 1000; // 1 hour

  const aggregationInterval = setInterval(async () => {
    try {
      await queue.add('aggregate-metrics', {}, {
        attempts: 1,
        removeOnComplete: true,
      });
    } catch (error) {
      console.error('Failed to schedule aggregation:', error);
    }
  }, AGGREGATION_INTERVAL);

  // Schedule continuous sync for all active contracts
  // Check every 30 seconds to keep contracts up to date
  const SYNC_INTERVAL = 30 * 1000; // 30 seconds

  const syncInterval = setInterval(async () => {
    try {
      const { query } = await import('../db');

      // Sync all contracts that are ready to sync
      // 'synced' = ready to catch up with new blocks
      // 'error' = retry after error
      // Note: We don't include 'syncing' here to avoid conflicts with already-running jobs
      // Note: We don't include 'pending' here as those go through discover-contract first
      const contracts = await query<{ id: string; network_name: string; stablecoin_name: string }>(
        `SELECT c.id, n.name as network_name, s.name as stablecoin_name
         FROM contracts c
         JOIN networks n ON c.network_id = n.id
         JOIN stablecoins s ON c.stablecoin_id = s.id
         JOIN sync_state ss ON c.id = ss.contract_id
         WHERE c.is_active = true AND ss.status IN ('synced', 'error')`
      );

      for (const contract of contracts) {
        const jobId = `sync-${contract.id}`;

        // Check if job already exists to avoid unnecessary operations
        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          // Only add if not already waiting or active
          if (state === 'waiting' || state === 'active' || state === 'delayed') {
            continue;
          }
          // Remove completed or failed jobs
          await existingJob.remove();
        }

        await queue.add('sync-contract', {
          contractId: contract.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          jobId,
        });
      }
    } catch (error) {
      console.error('Failed to schedule sync jobs:', error);
    }
  }, SYNC_INTERVAL);

  console.log('Indexer worker is running. Waiting for jobs...');

  // Graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) {
      console.log('Shutdown already in progress...');
      return;
    }

    console.log('Shutting down indexer worker...');
    isShuttingDown = true;

    // Set a timeout to force exit if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit...');
      process.exit(1);
    }, 10000); // 10 seconds timeout

    try {
      // Stop scheduling new jobs
      clearInterval(aggregationInterval);
      clearInterval(syncInterval);
      console.log('Stopped scheduling intervals');

      // Pause the queue to prevent new job processing
      await queue.pause(true, true); // pause locally and globally
      console.log('Queue paused');

      // Close queue connections
      await closeQueue();
      console.log('Queue closed');

      // Close database pool
      await closePool();
      console.log('Database pool closed');

      // Clear the force exit timeout since we succeeded
      clearTimeout(forceExitTimeout);

      console.log('Indexer worker stopped gracefully');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Failed to start indexer worker:', error);
  process.exit(1);
});
