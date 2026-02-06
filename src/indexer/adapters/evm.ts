import { ethers, Contract, Provider, JsonRpcProvider } from 'ethers';
import { BlockchainAdapter, registerAdapter } from './base';
import { ChainType, TransferEvent, MintEvent, BurnEvent } from '../../types';
import { isShutdownRequested } from '../worker';
import { RateLimitService } from '../rateLimit';
import { StatusLineReporter } from '../statusLineReporter';

// Standard ERC20 ABI for Transfer events and basic functions
const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

// Zero address for detecting mints/burns
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Max block range for getLogs (varies by RPC provider)
const MAX_BLOCK_RANGE = 10000;

// Transaction receipt retry settings
const MAX_RECEIPT_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 500;

// Helper function to sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to add timeout to promises
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// RPC call timeout - 60 seconds for most calls
const RPC_TIMEOUT_MS = 60000;

export class EVMAdapter implements BlockchainAdapter {
  readonly chainType: ChainType = 'evm';

  private provider: JsonRpcProvider | null = null;
  private rpcEndpoint: string = '';
  private rateLimiter: RateLimitService | null = null;
  private endpointId: string | null = null;
  private maxRequestsPerSecond: number | null = null;

  setRateLimiter(rateLimiter: RateLimitService, endpointId: string, maxRequestsPerSecond: number): void {
    this.rateLimiter = rateLimiter;
    this.endpointId = endpointId;
    this.maxRequestsPerSecond = maxRequestsPerSecond;
  }

  private async acquireRateLimitToken(rpcCall?: string): Promise<void> {
    if (this.rateLimiter && this.endpointId && this.maxRequestsPerSecond) {
      if (rpcCall) {
        StatusLineReporter.getInstance().trackRpcCall(rpcCall);
      }
      await this.rateLimiter.acquireToken(this.endpointId, this.maxRequestsPerSecond);
    }
  }

  async connect(rpcEndpoint: string): Promise<void> {
    this.rpcEndpoint = rpcEndpoint;
    this.provider = new JsonRpcProvider(rpcEndpoint, undefined, {
      staticNetwork: true, // Skip automatic network detection
      batchMaxCount: 1,    // Disable request batching
    });

    // Test connection with timeout
    await this.acquireRateLimitToken('eth_blockNumber (connect test)');
    await withTimeout(
      this.provider.getBlockNumber(),
      RPC_TIMEOUT_MS,
      'Connection test'
    );
  }

  async disconnect(): Promise<void> {
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
  }

  isConnected(): boolean {
    return this.provider !== null;
  }

  private getProvider(): JsonRpcProvider {
    if (!this.provider) {
      throw new Error('Not connected. Call connect() first.');
    }
    return this.provider;
  }

  async getCurrentBlockNumber(): Promise<number> {
    await this.acquireRateLimitToken('eth_blockNumber');
    return withTimeout(
      this.getProvider().getBlockNumber(),
      RPC_TIMEOUT_MS,
      'getCurrentBlockNumber'
    );
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    await this.acquireRateLimitToken(`eth_getBlockByNumber (${blockNumber})`);
    const block = await withTimeout(
      this.getProvider().getBlock(blockNumber),
      RPC_TIMEOUT_MS,
      `getBlockTimestamp(${blockNumber})`
    );
    if (!block) {
      throw new Error(`Block ${blockNumber} not found`);
    }
    return block.timestamp;
  }

  async getContractCreationBlock(address: string): Promise<number | null> {
    const provider = this.getProvider();
    await this.acquireRateLimitToken('eth_blockNumber');
    const currentBlock = await withTimeout(
      provider.getBlockNumber(),
      RPC_TIMEOUT_MS,
      'getContractCreationBlock - getCurrentBlock'
    );

    // Check if contract exists now
    await this.acquireRateLimitToken(`eth_getCode (${address})`);
    const code = await withTimeout(
      provider.getCode(address),
      RPC_TIMEOUT_MS,
      `getCode ${address}`
    );
    if (code === '0x') {
      return null; // No contract at this address
    }

    // Try binary search with archive node (only works if RPC supports historical state)
    let archiveNodeWorks = false;
    try {
      // Test if we can query historical state
      const testBlock = Math.max(1, currentBlock - 1000);
      await this.acquireRateLimitToken(`eth_getCode (${address} @ ${testBlock})`);
      await withTimeout(
        provider.getCode(address, testBlock),
        RPC_TIMEOUT_MS,
        `getCode ${address} @ ${testBlock}`
      );
      archiveNodeWorks = true;
    } catch {
      console.log('  Archive node not available, will search for first Transfer event instead');
    }

    if (archiveNodeWorks) {
      // Binary search for contract creation block
      let low = 0;
      let high = currentBlock;

      while (low < high) {
        const mid = Math.floor((low + high) / 2);

        try {
          await this.acquireRateLimitToken(`eth_getCode (${address} @ ${mid})`);
          const codeAtMid = await withTimeout(
            provider.getCode(address, mid),
            RPC_TIMEOUT_MS,
            `getCode ${address} @ ${mid}`
          );
          if (codeAtMid === '0x') {
            low = mid + 1;
          } else {
            high = mid;
          }
        } catch {
          // If we can't get code at this block, assume contract didn't exist
          low = mid + 1;
        }
      }

      return low;
    } else {
      // Fallback: Search for first Transfer event
      // This is slower but works with regular full nodes
      console.log('  Searching for first Transfer event (this may take a while)...');

      const contract = new Contract(address, ERC20_ABI, provider);
      const searchRange = 10000;

      // Search in chunks from block 0
      for (let start = 0; start < currentBlock; start += searchRange) {
        // Check for shutdown request
        if (isShutdownRequested()) {
          console.log('  Shutdown requested, stopping creation block search');
          return null;
        }

        const end = Math.min(start + searchRange - 1, currentBlock);

        try {
          await this.acquireRateLimitToken(`eth_getLogs (Transfer ${start}-${end})`);
          const filter = contract.filters.Transfer();
          const logs = await withTimeout(
            contract.queryFilter(filter, start, end),
            RPC_TIMEOUT_MS,
            `queryFilter Transfer ${start}-${end}`
          );

          if (logs.length > 0) {
            // Found first transfer event
            return logs[0].blockNumber;
          }
        } catch (error) {
          // Some ranges might fail, continue searching
          console.log(`  Error searching blocks ${start}-${end}, continuing...`);
        }
      }

      // If we couldn't find any Transfer events, return null
      return null;
    }
  }

  async getTokenDecimals(address: string): Promise<number> {
    const contract = new Contract(address, ERC20_ABI, this.getProvider());
    try {
      await this.acquireRateLimitToken(`eth_call (decimals ${address})`);
      return await withTimeout(
        contract.decimals(),
        RPC_TIMEOUT_MS,
        `getTokenDecimals ${address}`
      );
    } catch {
      return 18; // Default to 18 decimals
    }
  }

  async getTotalSupply(address: string): Promise<string> {
    const contract = new Contract(address, ERC20_ABI, this.getProvider());
    await this.acquireRateLimitToken(`eth_call (totalSupply ${address})`);
    const supply = await withTimeout(
      contract.totalSupply(),
      RPC_TIMEOUT_MS,
      `getTotalSupply ${address}`
    );
    return supply.toString();
  }

  async getTransferEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    const provider = this.getProvider();
    const contract = new Contract(address, ERC20_ABI, provider);
    const events: TransferEvent[] = [];

    // Process in chunks to avoid RPC limits
    for (let start = fromBlock; start <= toBlock; start += MAX_BLOCK_RANGE) {
      // Check for shutdown request
      if (isShutdownRequested()) {
        console.log('  Shutdown requested, stopping transfer event fetch');
        break;
      }

      const end = Math.min(start + MAX_BLOCK_RANGE - 1, toBlock);

      await this.acquireRateLimitToken(`eth_getLogs (Transfer ${start}-${end})`);
      const filter = contract.filters.Transfer();
      const logs = await withTimeout(
        contract.queryFilter(filter, start, end),
        RPC_TIMEOUT_MS,
        `queryFilter Transfer ${start}-${end}`
      );

      for (const log of logs) {
        await this.acquireRateLimitToken(`eth_getBlockByHash (${log.blockHash.slice(0, 10)}...)`);
        const block = await withTimeout(
          log.getBlock(),
          RPC_TIMEOUT_MS,
          `getBlock for tx ${log.transactionHash}`
        );
        const parsed = contract.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });

        if (parsed) {
          events.push({
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            from: parsed.args[0],
            to: parsed.args[1],
            value: parsed.args[2].toString(),
            timestamp: block.timestamp,
          });
        }
      }
    }

    return events;
  }

  async getMintBurnEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<{ mints: MintEvent[]; burns: BurnEvent[] }> {
    const transfers = await this.getTransferEvents(address, fromBlock, toBlock);

    const mints: MintEvent[] = [];
    const burns: BurnEvent[] = [];

    for (const transfer of transfers) {
      if (transfer.from === ZERO_ADDRESS) {
        // Mint event
        mints.push({
          blockNumber: transfer.blockNumber,
          txHash: transfer.txHash,
          to: transfer.to,
          value: transfer.value,
          timestamp: transfer.timestamp,
        });
      } else if (transfer.to === ZERO_ADDRESS) {
        // Burn event
        burns.push({
          blockNumber: transfer.blockNumber,
          txHash: transfer.txHash,
          from: transfer.from,
          value: transfer.value,
          timestamp: transfer.timestamp,
        });
      }
    }

    return { mints, burns };
  }

  async getTransactionFee(txHash: string): Promise<{ feeNative: string; feeUsd: string | null }> {
    const provider = this.getProvider();

    let lastError: Error | null = null;

    // Retry with exponential backoff
    for (let attempt = 0; attempt < MAX_RECEIPT_RETRIES; attempt++) {
      // Check for shutdown request
      if (isShutdownRequested()) {
        throw new Error('Shutdown requested');
      }

      try {
        await this.acquireRateLimitToken(`eth_getTransactionReceipt (${txHash.slice(0, 10)}...)`);
        const receipt = await withTimeout(
          provider.getTransactionReceipt(txHash),
          RPC_TIMEOUT_MS,
          `getTransactionReceipt ${txHash}`
        );

        if (!receipt) {
          // Receipt not found, will retry
          lastError = new Error(`Transaction ${txHash} not found`);

          if (attempt < MAX_RECEIPT_RETRIES - 1) {
            const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
            console.log(`  Transaction receipt not found for ${txHash}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RECEIPT_RETRIES})...`);
            await sleep(delayMs);
            continue;
          }

          throw lastError;
        }

        const fee = receipt.gasUsed * receipt.gasPrice;
        return {
          feeNative: fee.toString(),
          feeUsd: null, // Would need price oracle for USD conversion
        };
      } catch (error) {
        lastError = error as Error;

        // If it's a network error or timeout, retry
        if (attempt < MAX_RECEIPT_RETRIES - 1) {
          const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.log(`  Error fetching transaction receipt for ${txHash}: ${lastError.message}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RECEIPT_RETRIES})...`);
          await sleep(delayMs);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error(`Transaction ${txHash} not found after ${MAX_RECEIPT_RETRIES} attempts`);
  }

  async getTransactionFees(txHashes: string[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>> {
    const results = new Map<string, { feeNative: string; feeUsd: string | null }>();

    // Process in parallel batches (smaller batch to avoid overwhelming the RPC)
    const batchSize = 5;
    for (let i = 0; i < txHashes.length; i += batchSize) {
      // Check for shutdown request
      if (isShutdownRequested()) {
        console.log('  Shutdown requested, stopping transaction fee fetch');
        break;
      }

      const batch = txHashes.slice(i, i + batchSize);
      const promises = batch.map(async (txHash) => {
        try {
          // No outer timeout - let the retry logic in getTransactionFee handle it
          // Each of 5 attempts has 60s timeout, so max ~5 minutes with retries
          const fee = await this.getTransactionFee(txHash);
          results.set(txHash, fee);
        } catch (error) {
          console.error(`Failed to get fee for ${txHash}: ${(error as Error).message}`);
          // Set fee to 0 if we can't get it after all retries
          results.set(txHash, { feeNative: '0', feeUsd: null });
        }
      });

      // Add timeout to Promise.all to prevent batch from hanging indefinitely
      // Allow enough time for all retries: 5 attempts × 60s + delays ≈ 5 minutes per tx
      // Since they run in parallel, batch timeout = slowest transaction time + buffer
      try {
        await withTimeout(
          Promise.all(promises),
          RPC_TIMEOUT_MS * 10, // 10 minutes for entire batch (allows full retry cycles)
          `getTransactionFees batch ${i}-${i + batch.length}`
        );
      } catch (error) {
        console.error(`Batch ${i}-${i + batch.length} timed out: ${(error as Error).message}`);
        // Fill in remaining txs with zero fees
        for (const txHash of batch) {
          if (!results.has(txHash)) {
            results.set(txHash, { feeNative: '0', feeUsd: null });
          }
        }
      }

      // Small delay between batches to avoid overwhelming the RPC
      if (i + batchSize < txHashes.length) {
        await sleep(100);
      }
    }

    return results;
  }
}

// Register the EVM adapter
registerAdapter('evm', async (rpcEndpoint: string) => {
  const adapter = new EVMAdapter();
  await adapter.connect(rpcEndpoint);
  return adapter;
});

export default EVMAdapter;
