import { ChainType, TransferEvent, MintEvent, BurnEvent } from '../../types';
import { RateLimitService } from '../rateLimit';

export interface BlockchainAdapter {
  readonly chainType: ChainType;

  // Connection management
  connect(rpcEndpoint: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Block info
  getCurrentBlockNumber(): Promise<number>;
  getBlockTimestamp(blockNumber: number): Promise<number>;

  // Contract discovery
  getContractCreationBlock(address: string): Promise<number | null>;

  // Token info
  getTokenDecimals(address: string): Promise<number>;
  getTotalSupply(address: string): Promise<string>;

  // Event fetching
  getTransferEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]>;

  getMintBurnEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<{ mints: MintEvent[]; burns: BurnEvent[] }>;

  // Fee calculation
  getTransactionFee(txHash: string): Promise<{
    feeNative: string;
    feeUsd: string | null;
  }>;

  // Batch transaction fees (more efficient)
  getTransactionFees(txHashes: string[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>>;
}

/**
 * Rate-limited adapter wrapper that transparently adds rate limiting to any blockchain adapter.
 * Acquires a token from the rate limiter before each RPC call.
 */
export class RateLimitedAdapter implements BlockchainAdapter {
  readonly chainType: ChainType;

  constructor(
    private inner: BlockchainAdapter,
    private rateLimiter: RateLimitService,
    private endpointId: string,
    private maxRequestsPerMinute: number
  ) {
    this.chainType = inner.chainType;
  }

  async connect(rpcEndpoint: string): Promise<void> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.connect(rpcEndpoint);
  }

  async disconnect(): Promise<void> {
    // No rate limiting on disconnect
    return this.inner.disconnect();
  }

  isConnected(): boolean {
    // No rate limiting on local state check
    return this.inner.isConnected();
  }

  async getCurrentBlockNumber(): Promise<number> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getCurrentBlockNumber();
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getBlockTimestamp(blockNumber);
  }

  async getContractCreationBlock(address: string): Promise<number | null> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getContractCreationBlock(address);
  }

  async getTokenDecimals(address: string): Promise<number> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getTokenDecimals(address);
  }

  async getTotalSupply(address: string): Promise<string> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getTotalSupply(address);
  }

  async getTransferEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getTransferEvents(address, fromBlock, toBlock);
  }

  async getMintBurnEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<{ mints: MintEvent[]; burns: BurnEvent[] }> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getMintBurnEvents(address, fromBlock, toBlock);
  }

  async getTransactionFee(txHash: string): Promise<{
    feeNative: string;
    feeUsd: string | null;
  }> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getTransactionFee(txHash);
  }

  async getTransactionFees(txHashes: string[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerMinute);
    return this.inner.getTransactionFees(txHashes);
  }
}

// Factory function type
export type AdapterFactory = (rpcEndpoint: string) => Promise<BlockchainAdapter>;

// Registry of adapters by chain type
const adapterFactories = new Map<ChainType, AdapterFactory>();

export function registerAdapter(chainType: ChainType, factory: AdapterFactory): void {
  adapterFactories.set(chainType, factory);
}

export async function createAdapter(
  chainType: ChainType,
  rpcEndpoint: string,
  rateLimitConfig?: {
    rateLimiter: RateLimitService;
    endpointId: string;
    maxRequestsPerMinute: number;
  }
): Promise<BlockchainAdapter> {
  const factory = adapterFactories.get(chainType);
  if (!factory) {
    throw new Error(`No adapter registered for chain type: ${chainType}`);
  }

  const adapter = await factory(rpcEndpoint);

  // Wrap with rate limiting if config provided
  if (rateLimitConfig) {
    return new RateLimitedAdapter(
      adapter,
      rateLimitConfig.rateLimiter,
      rateLimitConfig.endpointId,
      rateLimitConfig.maxRequestsPerMinute
    );
  }

  return adapter;
}

export function hasAdapter(chainType: ChainType): boolean {
  return adapterFactories.has(chainType);
}
