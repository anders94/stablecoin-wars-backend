import Queue from 'bull';
import Redis from 'ioredis';

let indexerQueue: Queue.Queue | null = null;

export function getIndexerQueue(): Queue.Queue {
  if (!indexerQueue) {
    const redisOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      maxRetriesPerRequest: null,
    };

    indexerQueue = new Queue('stablecoin-indexer', {
      createClient: (type) => {
        switch (type) {
          case 'client':
            return new Redis(redisOptions);
          case 'subscriber':
            return new Redis(redisOptions);
          case 'bclient':
            return new Redis(redisOptions);
          default:
            return new Redis(redisOptions);
        }
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
      },
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
