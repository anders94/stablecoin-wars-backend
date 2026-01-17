import dotenv from 'dotenv';
dotenv.config();

import { getIndexerQueue, closeQueue } from './queue';
import { discoverContract, syncContract } from './processor';
import { aggregateMetrics, runFullAggregation } from './aggregator';
import { closePool } from '../db';

// Import adapters to register them
import './adapters';

async function main() {
  console.log('Starting Stablecoin Wars Indexer Worker...');

  const queue = getIndexerQueue();

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
  queue.on('completed', (job, result) => {
    console.log(`Job ${job.id} (${job.name}) completed:`, result);
  });

  queue.on('failed', (job, err) => {
    console.error(`Job ${job?.id} (${job?.name}) failed:`, err);
  });

  queue.on('error', (err) => {
    console.error('Queue error:', err);
  });

  // Schedule periodic aggregation
  const AGGREGATION_INTERVAL = 60 * 60 * 1000; // 1 hour

  setInterval(async () => {
    try {
      await queue.add('aggregate-metrics', {}, {
        attempts: 1,
        removeOnComplete: true,
      });
    } catch (error) {
      console.error('Failed to schedule aggregation:', error);
    }
  }, AGGREGATION_INTERVAL);

  // Schedule periodic sync for all contracts
  const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

  setInterval(async () => {
    try {
      const { query } = await import('../db');
      const contracts = await query<{ id: string }>(
        `SELECT c.id FROM contracts c
         JOIN sync_state ss ON c.id = ss.contract_id
         WHERE c.is_active = true AND ss.status = 'synced'`
      );

      for (const contract of contracts) {
        await queue.add('sync-contract', {
          contractId: contract.id,
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          jobId: `sync-${contract.id}`, // Prevent duplicate jobs
        });
      }
    } catch (error) {
      console.error('Failed to schedule sync jobs:', error);
    }
  }, SYNC_INTERVAL);

  console.log('Indexer worker is running. Waiting for jobs...');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down indexer worker...');
    await closeQueue();
    await closePool();
    console.log('Indexer worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Failed to start indexer worker:', error);
  process.exit(1);
});
