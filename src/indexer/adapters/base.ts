import { ChainType, TransferEvent, MintEvent, BurnEvent, ContractEvents, ContractEventsOptions } from '../../types';
import { EventSet } from '../eventSets';
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

  // Transfers plus the event set's other logs in one pass, with log indexes. Optional: adapters
  // without it only index Transfers. With opts.timestamps === false, timestamps are left 0.
  getContractEvents?(
    address: string,
    fromBlock: number,
    toBlock: number,
    eventSet: EventSet,
    opts?: ContractEventsOptions
  ): Promise<ContractEvents>;

  // The contract's owner() at a block (for supply events that implicitly credit the owner, such
  // as Tether's Issue and Redeem). Optional; null when the contract has no owner().
  getOwnerAt?(address: string, blockNumber: number): Promise<string | null>;

  // Every transaction fee in a block, keyed by lowercased tx hash. Optional.
  getBlockFees?(blockNumber: number): Promise<Map<string, { feeNative: string; feeUsd: string | null }>>;

  // Fee calculation
  getTransactionFee(txHash: string): Promise<{
    feeNative: string;
    feeUsd: string | null;
  }>;

  // Batch transaction fees (more efficient). blockNumbers, when given, are the blocks containing
  // txHashes; adapters that can fetch all of a block's receipts in one call use them.
  getTransactionFees(txHashes: string[], blockNumbers?: number[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>>;
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
    private maxRequestsPerSecond: number
  ) {
    this.chainType = inner.chainType;
  }

  async connect(rpcEndpoint: string): Promise<void> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
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
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getCurrentBlockNumber();
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getBlockTimestamp(blockNumber);
  }

  async getContractCreationBlock(address: string): Promise<number | null> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getContractCreationBlock(address);
  }

  async getTokenDecimals(address: string): Promise<number> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getTokenDecimals(address);
  }

  async getTotalSupply(address: string): Promise<string> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getTotalSupply(address);
  }

  async getTransferEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getTransferEvents(address, fromBlock, toBlock);
  }

  async getMintBurnEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<{ mints: MintEvent[]; burns: BurnEvent[] }> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getMintBurnEvents(address, fromBlock, toBlock);
  }

  async getTransactionFee(txHash: string): Promise<{
    feeNative: string;
    feeUsd: string | null;
  }> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getTransactionFee(txHash);
  }

  async getTransactionFees(txHashes: string[], blockNumbers?: number[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>> {
    await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    return this.inner.getTransactionFees(txHashes, blockNumbers);
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
    maxRequestsPerSecond: number;
  }
): Promise<BlockchainAdapter> {
  const factory = adapterFactories.get(chainType);
  if (!factory) {
    throw new Error(`No adapter registered for chain type: ${chainType}`);
  }

  const adapter = await factory(rpcEndpoint);

  // Configure rate limiting if provided
  if (rateLimitConfig) {
    // If adapter supports setRateLimiter, configure it directly
    if ('setRateLimiter' in adapter && typeof adapter.setRateLimiter === 'function') {
      (adapter as any).setRateLimiter(
        rateLimitConfig.rateLimiter,
        rateLimitConfig.endpointId,
        rateLimitConfig.maxRequestsPerSecond
      );
    }
    // Note: We no longer wrap with RateLimitedAdapter since the inner adapter handles it
  }

  return adapter;
}

export function hasAdapter(chainType: ChainType): boolean {
  return adapterFactories.has(chainType);
}
