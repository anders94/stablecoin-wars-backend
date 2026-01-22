import Queue, { Job } from 'bull';
import { RedisOptions } from 'ioredis';

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

    // Wait for job to be processed (blocks async if rate limited)
    await job.finished();
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
      const newQueue = new Queue<TokenJob>(`rpc-rate-limit:${endpointId}`, {
        redis: this.redisOptions,
        limiter: {
          max: maxRequestsPerSecond,  // Max requests (supports floats)
          duration: 1000,              // Per 1 second
        },
        defaultJobOptions: {
          removeOnComplete: true,  // Clean up immediately
          removeOnFail: true,
          attempts: 1,             // Token acquisition doesn't retry
        },
      });

      // Process jobs immediately (just grant token)
      newQueue.process(async (job: Job<TokenJob>) => {
        // Token granted - job completes immediately
        return { granted: true };
      });

      // Add event handlers for monitoring
      newQueue.on('failed', (job, err) => {
        console.error(`Token acquisition failed for ${endpointId}:`, err.message);
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
