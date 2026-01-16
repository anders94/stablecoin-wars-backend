import { ethers, Contract, Provider, JsonRpcProvider } from 'ethers';
import { BlockchainAdapter, registerAdapter } from './base';
import { ChainType, TransferEvent, MintEvent, BurnEvent } from '../../types';

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

export class EVMAdapter implements BlockchainAdapter {
  readonly chainType: ChainType = 'evm';

  private provider: JsonRpcProvider | null = null;
  private rpcEndpoint: string = '';

  async connect(rpcEndpoint: string): Promise<void> {
    this.rpcEndpoint = rpcEndpoint;
    this.provider = new JsonRpcProvider(rpcEndpoint);

    // Test connection
    await this.provider.getBlockNumber();
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
    return this.getProvider().getBlockNumber();
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.getProvider().getBlock(blockNumber);
    if (!block) {
      throw new Error(`Block ${blockNumber} not found`);
    }
    return block.timestamp;
  }

  async getContractCreationBlock(address: string): Promise<number | null> {
    const provider = this.getProvider();

    // Binary search for contract creation block
    const currentBlock = await provider.getBlockNumber();
    let low = 0;
    let high = currentBlock;

    // Check if contract exists now
    const code = await provider.getCode(address);
    if (code === '0x') {
      return null; // No contract at this address
    }

    // Binary search to find first block where contract exists
    while (low < high) {
      const mid = Math.floor((low + high) / 2);

      try {
        const codeAtMid = await provider.getCode(address, mid);
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
  }

  async getTokenDecimals(address: string): Promise<number> {
    const contract = new Contract(address, ERC20_ABI, this.getProvider());
    try {
      return await contract.decimals();
    } catch {
      return 18; // Default to 18 decimals
    }
  }

  async getTotalSupply(address: string): Promise<string> {
    const contract = new Contract(address, ERC20_ABI, this.getProvider());
    const supply = await contract.totalSupply();
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
      const end = Math.min(start + MAX_BLOCK_RANGE - 1, toBlock);

      const filter = contract.filters.Transfer();
      const logs = await contract.queryFilter(filter, start, end);

      for (const log of logs) {
        const block = await log.getBlock();
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
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      throw new Error(`Transaction ${txHash} not found`);
    }

    const fee = receipt.gasUsed * receipt.gasPrice;
    return {
      feeNative: fee.toString(),
      feeUsd: null, // Would need price oracle for USD conversion
    };
  }

  async getTransactionFees(txHashes: string[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>> {
    const results = new Map<string, { feeNative: string; feeUsd: string | null }>();

    // Process in parallel batches
    const batchSize = 10;
    for (let i = 0; i < txHashes.length; i += batchSize) {
      const batch = txHashes.slice(i, i + batchSize);
      const promises = batch.map(async (txHash) => {
        try {
          const fee = await this.getTransactionFee(txHash);
          results.set(txHash, fee);
        } catch (error) {
          console.warn(`Failed to get fee for ${txHash}:`, error);
          results.set(txHash, { feeNative: '0', feeUsd: null });
        }
      });
      await Promise.all(promises);
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
