import logUpdate from 'log-update';

interface RpcCallCounts {
  eth_blockNumber: number;
  eth_getLogs: number;
  eth_getBlockByHash: number;
  eth_getTransactionReceipt: number;
  eth_getCode: number;
  eth_call: number;
  eth_getBlockByNumber: number;
  other: number;
}

/**
 * Singleton service for tracking RPC calls and displaying a persistent status line at the terminal bottom.
 * Automatically detects TTY and falls back to periodic console.log summaries in non-TTY environments.
 */
export class StatusLineReporter {
  private static instance: StatusLineReporter;

  private rpcCounts: RpcCallCounts = {
    eth_blockNumber: 0,
    eth_getLogs: 0,
    eth_getBlockByHash: 0,
    eth_getTransactionReceipt: 0,
    eth_getCode: 0,
    eth_call: 0,
    eth_getBlockByNumber: 0,
    other: 0,
  };

  private updateInterval: NodeJS.Timeout | null = null;
  private summaryInterval: NodeJS.Timeout | null = null;
  private isTTY: boolean = false;
  private isRunning: boolean = false;
  private lastUpdateTime: number = Date.now();
  private callsInLastSecond: number = 0;
  private totalCalls: number = 0;
  private rateHistory: number[] = [];

  private constructor() {
    this.isTTY = process.stdout.isTTY || false;
  }

  public static getInstance(): StatusLineReporter {
    if (!StatusLineReporter.instance) {
      StatusLineReporter.instance = new StatusLineReporter();
    }
    return StatusLineReporter.instance;
  }

  /**
   * Start the status line reporter
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.lastUpdateTime = Date.now();

    if (this.isTTY) {
      // In TTY mode, update the status line every 500ms
      this.updateInterval = setInterval(() => {
        this.updateStatusLine();
      }, 500);
    } else {
      // In non-TTY mode, print summaries every 30 seconds
      this.summaryInterval = setInterval(() => {
        this.printSummary();
      }, 30000);
    }
  }

  /**
   * Stop the status line reporter and persist the final status
   */
  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.summaryInterval) {
      clearInterval(this.summaryInterval);
      this.summaryInterval = null;
    }

    if (this.isTTY) {
      // Persist the final status line
      logUpdate.done();
    } else {
      // Print final summary
      this.printSummary();
    }
  }

  /**
   * Track an RPC call by parsing its type and incrementing the counter
   */
  public trackRpcCall(rpcCall: string): void {
    const type = this.parseRpcCallType(rpcCall);

    if (type in this.rpcCounts) {
      this.rpcCounts[type as keyof RpcCallCounts]++;
    } else {
      this.rpcCounts.other++;
    }

    this.totalCalls++;
    this.callsInLastSecond++;
  }

  /**
   * Log a message that should scroll normally above the status line
   */
  public log(message: string): void {
    if (this.isTTY && this.isRunning) {
      // Clear the status line, print the message, then redraw the status line
      logUpdate.clear();
      console.log(message);
      this.updateStatusLine();
    } else {
      // In non-TTY mode, just use regular console.log
      console.log(message);
    }
  }

  /**
   * Parse the RPC call type from a descriptive string
   * Examples:
   *   "eth_getLogs (Transfer 0-1000)" -> "eth_getLogs"
   *   "eth_blockNumber" -> "eth_blockNumber"
   *   "eth_getBlockByHash (0x123...)" -> "eth_getBlockByHash"
   */
  private parseRpcCallType(rpcCall: string): string {
    // Extract the method name (everything before the first space or parenthesis)
    const match = rpcCall.match(/^([a-zA-Z_]+)/);
    return match ? match[1] : 'other';
  }

  /**
   * Format the status line string
   */
  private formatStatusLine(): string {
    const shortNames: Record<keyof RpcCallCounts, string> = {
      eth_blockNumber: 'blockNum',
      eth_getLogs: 'getLogs',
      eth_getBlockByHash: 'getBlock',
      eth_getTransactionReceipt: 'getReceipt',
      eth_getCode: 'getCode',
      eth_call: 'call',
      eth_getBlockByNumber: 'getBlockNum',
      other: 'other',
    };

    const parts: string[] = [];

    // Add counts for each RPC type that has been called
    for (const [key, shortName] of Object.entries(shortNames)) {
      const count = this.rpcCounts[key as keyof RpcCallCounts];
      if (count > 0) {
        parts.push(`${shortName}=${count}`);
      }
    }

    const countsStr = parts.join(' | ');

    // Calculate rate
    const rate = this.calculateRate();
    const rateStr = rate > 0 ? ` @ ${rate}/sec` : '';

    return `[RPC Calls] ${countsStr} (total: ${this.totalCalls})${rateStr}`;
  }

  /**
   * Calculate the current RPC call rate (calls per second)
   */
  private calculateRate(): number {
    const now = Date.now();
    const elapsed = (now - this.lastUpdateTime) / 1000;

    if (elapsed >= 1) {
      const rate = Math.round(this.callsInLastSecond / elapsed);

      // Update rate history (keep last 10 measurements for smoothing)
      this.rateHistory.push(rate);
      if (this.rateHistory.length > 10) {
        this.rateHistory.shift();
      }

      // Reset counters
      this.callsInLastSecond = 0;
      this.lastUpdateTime = now;

      // Return average of recent rates for smoother display
      return Math.round(
        this.rateHistory.reduce((sum, r) => sum + r, 0) / this.rateHistory.length
      );
    }

    // Return the last known rate
    return this.rateHistory.length > 0
      ? Math.round(
          this.rateHistory.reduce((sum, r) => sum + r, 0) / this.rateHistory.length
        )
      : 0;
  }

  /**
   * Update the status line (TTY mode only)
   */
  private updateStatusLine(): void {
    if (!this.isTTY || !this.isRunning) {
      return;
    }

    const statusLine = this.formatStatusLine();
    logUpdate(statusLine);
  }

  /**
   * Print a summary (non-TTY mode only)
   */
  private printSummary(): void {
    if (this.isTTY) {
      return;
    }

    const statusLine = this.formatStatusLine();
    console.log(statusLine);
  }

  /**
   * Reset all counters (useful for testing or per-batch resets)
   */
  public reset(): void {
    this.rpcCounts = {
      eth_blockNumber: 0,
      eth_getLogs: 0,
      eth_getBlockByHash: 0,
      eth_getTransactionReceipt: 0,
      eth_getCode: 0,
      eth_call: 0,
      eth_getBlockByNumber: 0,
      other: 0,
    };
    this.totalCalls = 0;
    this.callsInLastSecond = 0;
    this.rateHistory = [];
    this.lastUpdateTime = Date.now();
  }
}
