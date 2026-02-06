import dotenv from 'dotenv';
dotenv.config();

import { getIndexerQueue, closeQueue } from './queue';
import { discoverContract, syncContract } from './processor';
import { aggregateMetrics, runFullAggregation } from './aggregator';
import { closePool } from '../db';
import { StatusLineReporter } from './statusLineReporter';

// Import adapters to register them
import './adapters';

// Global shutdown flag
let isShuttingDown = false;

export function isShutdownRequested(): boolean {
  return isShuttingDown;
}

async function main() {
  StatusLineReporter.getInstance().log('Starting Stablecoin Wars Indexer Worker...');

  const queue = getIndexerQueue();

  // Increase max listeners to handle multiple rate limit queues
  // Each rate limiter queue adds listeners, and we may have many RPC endpoints
  queue.setMaxListeners(50);

  // Keep queue paused during initialization to prevent race conditions
  await queue.pause(true); // Pause both locally and globally
  StatusLineReporter.getInstance().log('Queue paused for initialization');

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
    StatusLineReporter.getInstance().log(`Processing discover-contract job for ${contract?.stablecoin_name || 'unknown'} on ${contract?.network_name || 'unknown'}`);
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
    StatusLineReporter.getInstance().log(`Processing sync-contract job for ${contract?.stablecoin_name || 'unknown'} on ${contract?.network_name || 'unknown'}`);
    await syncContract(job.data.contractId);
    return { success: true };
  });

  // Process aggregate-metrics jobs
  queue.process('aggregate-metrics', async (job) => {
    StatusLineReporter.getInstance().log(`Processing aggregate-metrics job`);
    if (job.data.contractId) {
      await aggregateMetrics(job.data.contractId);
    } else {
      await runFullAggregation();
    }
    return { success: true };
  });

  // Event handlers
  queue.on('active', (job) => {
    StatusLineReporter.getInstance().log(`Job ${job.id} (${job.name}) started processing`);
  });

  queue.on('completed', (job, result) => {
    StatusLineReporter.getInstance().log(`Job ${job.id} (${job.name}) completed: ${JSON.stringify(result)}`);
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
    StatusLineReporter.getInstance().log('Initializing contracts...');

    // Clean up any stuck or stalled jobs from previous runs
    const activeJobs = await queue.getActive();
    const waitingJobs = await queue.getWaiting();
    const delayedJobs = await queue.getDelayed();

    StatusLineReporter.getInstance().log(`Queue status: ${activeJobs.length} active, ${waitingJobs.length} waiting, ${delayedJobs.length} delayed`);

    // Remove stuck active jobs (from crashed previous runs)
    for (const job of activeJobs) {
      StatusLineReporter.getInstance().log(`  Cleaning up stuck active job: ${job.id} (${job.name})`);
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
      StatusLineReporter.getInstance().log(`Found ${pendingContracts.length} contracts to discover and sync`);
      for (const contract of pendingContracts) {
        StatusLineReporter.getInstance().log(`  Queueing discovery for ${contract.stablecoin_name} on ${contract.network_name}`);
        const jobId = `discover-${contract.id}`;

        // Check if job already exists
        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();

          // Remove failed or completed jobs so they can be retried
          if (state === 'failed' || state === 'completed') {
            try {
              StatusLineReporter.getInstance().log(`    Cleaning up ${state} job ${jobId}`);
              await existingJob.remove();
            } catch (err) {
              // Job might have been removed by another process or expired
              StatusLineReporter.getInstance().log(`    Could not remove ${state} job ${jobId}, continuing anyway`);
            }
          } else {
            // Skip active, waiting, or delayed jobs (let them continue)
            StatusLineReporter.getInstance().log(`    Job ${jobId} already exists (state: ${state}), skipping`);
            continue;
          }
        }

        await queue.add('discover-contract', {
          contractId: contract.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          timeout: 7200000, // 2 hours for discovery
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
      StatusLineReporter.getInstance().log(`Found ${activeContracts.length} contracts to sync`);
      for (const contract of activeContracts) {
        StatusLineReporter.getInstance().log(`  Queueing sync for ${contract.stablecoin_name} on ${contract.network_name} (status: ${contract.status})`);
        const jobId = `sync-${contract.id}`;

        // Check if job already exists
        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();

          // Remove failed or completed jobs so they can be retried
          if (state === 'failed' || state === 'completed') {
            try {
              StatusLineReporter.getInstance().log(`    Cleaning up ${state} job ${jobId}`);
              await existingJob.remove();
            } catch (err) {
              // Job might have been removed by another process or expired
              StatusLineReporter.getInstance().log(`    Could not remove ${state} job ${jobId}, continuing anyway`);
            }
          } else {
            // Skip active, waiting, or delayed jobs (let them continue)
            StatusLineReporter.getInstance().log(`    Job ${jobId} already exists (state: ${state}), skipping`);
            continue;
          }
        }

        await queue.add('sync-contract', {
          contractId: contract.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          timeout: 86400000, // 24 hour timeout for sync (large contracts need time)
          jobId,
        });
      }
    }

    if (pendingContracts.length === 0 && activeContracts.length === 0) {
      StatusLineReporter.getInstance().log('No contracts found to sync');
    }

    StatusLineReporter.getInstance().log('Initialization complete');
  }

  // Run initialization
  await initializeContracts();

  // Resume queue after initialization
  await queue.resume(true); // Resume both locally and globally
  console.log('Queue resumed and ready to process jobs');

  // Start the status line reporter
  StatusLineReporter.getInstance().start();

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
      const { query, execute } = await import('../db');

      // First, detect and recover stuck contracts
      // A contract is stuck if it's in 'syncing' status for more than 2 hours without progress
      // (Jobs can run up to 24 hours, but should update status more frequently)
      const stuckContracts = await query<{ id: string; network_name: string; stablecoin_name: string; updated_at: Date }>(
        `SELECT c.id, n.name as network_name, s.name as stablecoin_name, ss.updated_at
         FROM contracts c
         JOIN networks n ON c.network_id = n.id
         JOIN stablecoins s ON c.stablecoin_id = s.id
         JOIN sync_state ss ON c.id = ss.contract_id
         WHERE c.is_active = true
           AND ss.status = 'syncing'
           AND ss.updated_at < NOW() - INTERVAL '2 hours'`
      );

      for (const contract of stuckContracts) {
        const jobId = `sync-${contract.id}`;
        const job = await queue.getJob(jobId);

        // If no job exists or job is not active, this contract is stuck
        if (!job) {
          StatusLineReporter.getInstance().log(`Detected stuck contract: ${contract.stablecoin_name} on ${contract.network_name} (no job found)`);
          await execute(
            `UPDATE sync_state
             SET status = 'error',
                 error_message = 'Recovered from stuck syncing state (no active job)',
                 updated_at = NOW()
             WHERE contract_id = $1`,
            [contract.id]
          );
        } else {
          const state = await job.getState();
          if (state !== 'active' && state !== 'waiting' && state !== 'delayed') {
            StatusLineReporter.getInstance().log(`Detected stuck contract: ${contract.stablecoin_name} on ${contract.network_name} (job state: ${state})`);
            await execute(
              `UPDATE sync_state
               SET status = 'error',
                   error_message = 'Recovered from stuck syncing state (job in ${state} state)',
                   updated_at = NOW()
               WHERE contract_id = $1`,
              [contract.id]
            );
            try {
              await job.remove();
            } catch (err) {
              // Job might have been removed already, that's fine
              console.error(`Could not remove stuck job for ${contract.stablecoin_name}:`, (err as Error).message);
            }
          }
        }
      }

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
          try {
            await existingJob.remove();
          } catch (err) {
            // Job might have been removed already, that's fine
            console.error(`Could not remove ${state} job ${jobId}:`, (err as Error).message);
          }
        }

        await queue.add('sync-contract', {
          contractId: contract.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          timeout: 86400000, // 24 hour timeout for sync (large contracts need time)
          jobId,
        });
      }
    } catch (error) {
      console.error('Failed to schedule sync jobs:', error);
    }
  }, SYNC_INTERVAL);

  StatusLineReporter.getInstance().log('Indexer worker is running. Waiting for jobs...');

  // Graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) {
      StatusLineReporter.getInstance().log('Shutdown already in progress...');
      return;
    }

    console.log('Shutting down indexer worker...');
    isShuttingDown = true;

    // Stop the status line reporter
    StatusLineReporter.getInstance().stop();

    // Set a timeout to force exit if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit...');
      process.exit(1);
    }, 10000); // 10 seconds timeout

    try {
      // Stop scheduling new jobs
      clearInterval(aggregationInterval);
      clearInterval(syncInterval);
      StatusLineReporter.getInstance().log('Stopped scheduling intervals');

      // Pause the queue to prevent new job processing
      await queue.pause(true, true); // pause locally and globally
      StatusLineReporter.getInstance().log('Queue paused');

      // Close queue connections
      await closeQueue();
      StatusLineReporter.getInstance().log('Queue closed');

      // Close database pool
      await closePool();
      StatusLineReporter.getInstance().log('Database pool closed');

      // Clear the force exit timeout since we succeeded
      clearTimeout(forceExitTimeout);

      StatusLineReporter.getInstance().log('Indexer worker stopped gracefully');
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
