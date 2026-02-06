import Queue, { Job } from 'bull';
import Redis, { RedisOptions } from 'ioredis';

interface TokenJob {
  endpointId: string;
  requestId: string;
}

/**
 * Rate limiting service using Bull Queue token bucket pattern.
 *
 * Each RPC endpoint gets a dedicated Bull queue with configured rate limiter.
 * Before any RPC call, adapter acquires a "token" by adding a job to the endpoint's queue.
 * Bull's rate limiter enforces max requests per second (supports floating point rates).
 * If limit reached, job waits in queue (event-driven, no polling).
 * When rate limit allows, job processes immediately and RPC call executes.
 */
export class RateLimitService {
  private queues: Map<string, Queue.Queue<TokenJob>> = new Map();
  private endpointConfigs: Map<string, number> = new Map();

  constructor(private redisOptions: RedisOptions) {}

  /**
   * Acquires a rate limit token for an endpoint.
   * Waits (event-driven) if rate limit is exhausted.
   *
   * @param endpointId - Unique identifier for the RPC endpoint
   * @param maxRequestsPerSecond - Maximum requests per second allowed for this endpoint (supports floats)
   */
  async acquireToken(endpointId: string, maxRequestsPerSecond: number): Promise<void> {
    const queue = this.getOrCreateQueue(endpointId, maxRequestsPerSecond);

    const job = await queue.add({
      endpointId,
      requestId: `${Date.now()}-${Math.random()}`,
    });

    // Wait for job to be processed with timeout protection
    // If Bull queue has issues, this prevents infinite hangs
    const finishPromise = job.finished();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Rate limiter token acquisition timed out after 120s for endpoint ${endpointId}`));
      }, 120000); // 2 minute timeout
    });

    await Promise.race([finishPromise, timeoutPromise]);
  }

  /**
   * Gets or creates a Bull queue for an endpoint.
   * Recreates queue if rate limit configuration changes.
   */
  private getOrCreateQueue(endpointId: string, maxRequestsPerSecond: number): Queue.Queue<TokenJob> {
    let queue = this.queues.get(endpointId);

    // Create new queue if doesn't exist or config changed
    if (!queue || this.endpointConfigs.get(endpointId) !== maxRequestsPerSecond) {
      // Close old queue if exists
      if (queue) {
        queue.close().catch(err => console.error('Error closing old queue:', err));
      }

      // Create new queue with rate limiter
      const baseRedisOptions = {
        ...this.redisOptions,
        // Add connection recovery settings
        retryStrategy: (times: number) => {
          // Exponential backoff with max 30 seconds
          const delay = Math.min(times * 50, 30000);
          console.log(`Rate limiter ${endpointId} Redis retry attempt ${times}, waiting ${delay}ms`);
          return delay;
        },
        enableOfflineQueue: true,
        connectTimeout: 10000,
        keepAlive: 30000,
      };

      const newQueue = new Queue<TokenJob>(`rpc-rate-limit:${endpointId}`, {
        createClient: (type) => {
          // bclient and subscriber must not have enableReadyCheck or maxRetriesPerRequest set
          // See: https://github.com/OptimalBits/bull/issues/1873
          const clientOptions = type === 'client'
            ? { ...baseRedisOptions, maxRetriesPerRequest: null, enableReadyCheck: true }
            : { ...baseRedisOptions, maxRetriesPerRequest: null, enableReadyCheck: false };

          const client = new Redis(clientOptions);

          // Add connection event handlers
          client.on('error', (err: Error) => {
            console.error(`Rate limiter ${endpointId} Redis ${type} error:`, err.message);
          });

          client.on('reconnecting', () => {
            console.log(`Rate limiter ${endpointId} Redis ${type} reconnecting...`);
          });

          client.on('ready', () => {
            console.log(`Rate limiter ${endpointId} Redis ${type} ready`);
          });

          return client;
        },
        limiter: {
          max: maxRequestsPerSecond,  // Max requests (supports floats)
          duration: 1000,              // Per 1 second
        },
        defaultJobOptions: {
          removeOnComplete: true,  // Clean up immediately
          removeOnFail: true,
          attempts: 1,             // Token acquisition doesn't retry
          timeout: 300000,         // 5 minute timeout for token acquisition
        },
      });

      // Increase max listeners to handle multiple concurrent operations
      newQueue.setMaxListeners(50);

      // Process jobs immediately (just grant token)
      newQueue.process(async (job: Job<TokenJob>) => {
        // Token granted - job completes immediately
        return { granted: true };
      });

      // Add event handlers for monitoring
      newQueue.on('failed', (job, err) => {
        console.error(`Token acquisition failed for ${endpointId}:`, err.message);
      });

      newQueue.on('error', (err) => {
        console.error(`Rate limiter queue error for ${endpointId}:`, err.message);
      });

      this.queues.set(endpointId, newQueue);
      this.endpointConfigs.set(endpointId, maxRequestsPerSecond);

      return newQueue;
    }

    return queue;
  }

  /**
   * Closes all queues and cleans up resources.
   */
  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.queues.values()).map(q => q.close())
    );
    this.queues.clear();
    this.endpointConfigs.clear();
  }

  /**
   * Gets all active queues for monitoring.
   */
  getQueues(): Queue.Queue<TokenJob>[] {
    return Array.from(this.queues.values());
  }
}
