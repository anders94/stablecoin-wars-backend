/**
 * In-process rate limiting service.
 *
 * Each RPC endpoint gets an evenly-spaced request schedule: callers are
 * assigned slots 1000/maxRequestsPerSecond ms apart (supports floating point
 * rates, e.g. 0.5 = one request every 2 seconds) and sleep until their slot
 * arrives. Slots are granted in call order, so waiting is FIFO.
 *
 * Rate limits only need to hold within this process (each process talks to
 * the RPC endpoints independently), so no external coordination is required.
 * Note this means limits are per-process: running the indexer and a backfill
 * against the same endpoint at the same time will not share a budget.
 */
export class RateLimitService {
  // Per-endpoint timestamp (ms since epoch) of the next free request slot.
  private nextSlot: Map<string, number> = new Map();

  /**
   * Acquires a rate limit token for an endpoint.
   * Resolves immediately if a slot is free, otherwise sleeps until this
   * caller's slot arrives.
   *
   * @param endpointId - Unique identifier for the RPC endpoint
   * @param maxRequestsPerSecond - Maximum requests per second allowed for this endpoint (supports floats)
   */
  async acquireToken(endpointId: string, maxRequestsPerSecond: number): Promise<void> {
    if (!(maxRequestsPerSecond > 0)) {
      return;
    }

    const intervalMs = 1000 / maxRequestsPerSecond;
    const now = Date.now();
    const slot = Math.max(this.nextSlot.get(endpointId) ?? now, now);
    this.nextSlot.set(endpointId, slot + intervalMs);

    const waitMs = slot - now;
    if (waitMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Clears all endpoint schedules. Kept async for call-site compatibility.
   */
  async close(): Promise<void> {
    this.nextSlot.clear();
  }
}
