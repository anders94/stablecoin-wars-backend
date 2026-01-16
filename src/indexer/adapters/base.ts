import { ChainType, TransferEvent, MintEvent, BurnEvent } from '../../types';

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

// Factory function type
export type AdapterFactory = (rpcEndpoint: string) => Promise<BlockchainAdapter>;

// Registry of adapters by chain type
const adapterFactories = new Map<ChainType, AdapterFactory>();

export function registerAdapter(chainType: ChainType, factory: AdapterFactory): void {
  adapterFactories.set(chainType, factory);
}

export async function createAdapter(chainType: ChainType, rpcEndpoint: string): Promise<BlockchainAdapter> {
  const factory = adapterFactories.get(chainType);
  if (!factory) {
    throw new Error(`No adapter registered for chain type: ${chainType}`);
  }
  return factory(rpcEndpoint);
}

export function hasAdapter(chainType: ChainType): boolean {
  return adapterFactories.has(chainType);
}
