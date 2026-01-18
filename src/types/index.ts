// Database entity types

export interface Company {
  id: string;
  name: string;
  website: string | null;
  created_at: Date;
}

export interface Stablecoin {
  id: string;
  company_id: string;
  ticker: string;
  name: string;
  decimals: number;
  created_at: Date;
}

export interface Network {
  id: string;
  name: string;
  display_name: string;
  chain_type: ChainType;
  chain_id: string | null;
  block_time_seconds: number | null;
  created_at: Date;
}

export interface RpcEndpoint {
  id: string;
  url: string;
  max_requests_per_second: number;
  max_blocks_per_query: number;
  description: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Contract {
  id: string;
  stablecoin_id: string;
  network_id: string;
  contract_address: string;
  rpc_endpoint: string;  // Kept for backwards compatibility during migration
  rpc_endpoint_id: string;
  creation_block: number | null;
  creation_date: Date | null;
  is_active: boolean;
  created_at: Date;
}

export interface SyncState {
  id: string;
  contract_id: string;
  last_synced_block: number;
  last_synced_at: Date | null;
  status: SyncStatus;
  error_message: string | null;
  updated_at: Date;
}

export interface Metrics {
  id: string;
  contract_id: string;
  period_start: Date;
  resolution_seconds: number;
  total_supply: string | null;
  minted: string;
  burned: string;
  tx_count: number;
  unique_senders: number;
  unique_receivers: number;
  total_transferred: string;
  total_fees_native: string;
  total_fees_usd: string;
  start_block: number | null;
  end_block: number | null;
  created_at: Date;
  updated_at: Date;
}

// Enums
export type ChainType = 'evm' | 'tron' | 'solana';
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'error';

// Resolution constants (powers of 10 based on 1 day)
export const RESOLUTIONS = {
  DAY: 86400,           // 1 day
  TEN_DAYS: 864000,     // 10 days
  HUNDRED_DAYS: 8640000, // ~100 days
  THOUSAND_DAYS: 86400000, // ~1000 days (~2.7 years)
} as const;

export type Resolution = typeof RESOLUTIONS[keyof typeof RESOLUTIONS];

// Blockchain event types
export interface TransferEvent {
  blockNumber: number;
  txHash: string;
  from: string;
  to: string;
  value: string;
  timestamp: number;
}

export interface MintEvent {
  blockNumber: number;
  txHash: string;
  to: string;
  value: string;
  timestamp: number;
}

export interface BurnEvent {
  blockNumber: number;
  txHash: string;
  from: string;
  value: string;
  timestamp: number;
}

// API request/response types
export interface CreateCompanyRequest {
  name: string;
  website?: string;
}

export interface CreateStablecoinRequest {
  company_id: string;
  ticker: string;
  name: string;
  decimals?: number;
}

export interface CreateNetworkRequest {
  name: string;
  display_name: string;
  chain_type: ChainType;
  chain_id?: string;
  block_time_seconds?: number;
}

export interface CreateContractRequest {
  stablecoin_id: string;
  network_id: string;
  contract_address: string;
  rpc_endpoint: string;
}

export interface CreateRpcEndpointRequest {
  url: string;
  max_requests_per_second?: number;
  max_blocks_per_query?: number;
  description?: string;
}

export interface UpdateRpcEndpointRequest {
  max_requests_per_second?: number;
  max_blocks_per_query?: number;
  is_active?: boolean;
  description?: string;
}

export interface MetricsQueryParams {
  network?: string;
  from: string;
  to: string;
  resolution?: number | 'auto';
  metrics?: string;
}

export interface MetricsResponse {
  ticker: string;
  resolution_seconds: number;
  data: MetricsDataPoint[];
}

export interface MetricsDataPoint {
  period_start: string;
  networks: Record<string, MetricsValues>;
  total: MetricsValues;
}

export interface MetricsValues {
  total_supply?: string;
  minted?: string;
  burned?: string;
  tx_count?: number;
  unique_senders?: number;
  unique_receivers?: number;
  total_transferred?: string;
  total_fees_native?: string;
  total_fees_usd?: string;
}
