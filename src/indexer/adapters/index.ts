// Export base types and factory
export { BlockchainAdapter, createAdapter, registerAdapter, hasAdapter } from './base';

// Import adapters to trigger registration
import './evm';
import './tron';
import './solana';
