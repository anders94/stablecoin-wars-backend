import Queue from 'bull';
import Redis from 'ioredis';

let indexerQueue: Queue.Queue | null = null;

export function getIndexerQueue(): Queue.Queue {
  if (!indexerQueue) {
    const baseRedisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      retryStrategy: (times: number) => {
        // Exponential backoff with max 30 seconds
        const delay = Math.min(times * 50, 30000);
        console.log(`Main queue Redis connection retry attempt ${times}, waiting ${delay}ms`);
        return delay;
      },
      connectTimeout: 10000,
      keepAlive: 30000,
      enableOfflineQueue: true,
    };

    indexerQueue = new Queue('stablecoin-indexer', {
      createClient: (type) => {
        // bclient and subscriber must not have enableReadyCheck or maxRetriesPerRequest set
        // See: https://github.com/OptimalBits/bull/issues/1873
        const clientOptions = type === 'client'
          ? { ...baseRedisOptions, maxRetriesPerRequest: null, enableReadyCheck: true }
          : { ...baseRedisOptions, maxRetriesPerRequest: null, enableReadyCheck: false };

        const client = new Redis(clientOptions);

        // Add connection event handlers
        client.on('error', (err) => {
          console.error(`Redis ${type} connection error:`, err.message);
        });

        client.on('reconnecting', () => {
          console.log(`Redis ${type} reconnecting...`);
        });

        client.on('ready', () => {
          console.log(`Redis ${type} connection ready`);
        });

        return client;
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
      },
      settings: {
        // Increase max listeners to handle multiple rate limit queues
        maxListeners: 50,
      },
    });

    // Add queue event handlers
    indexerQueue.on('error', (err) => {
      console.error('Main queue error:', err.message);
    });
  }
  return indexerQueue;
}

export async function closeQueue(): Promise<void> {
  if (indexerQueue) {
    await indexerQueue.close();
    indexerQueue = null;
  }
}
