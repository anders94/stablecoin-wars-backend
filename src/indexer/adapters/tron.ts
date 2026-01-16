// eslint-disable-next-line @typescript-eslint/no-var-requires
const TronWeb = require('tronweb');
import { BlockchainAdapter, registerAdapter } from './base';
import { ChainType, TransferEvent, MintEvent, BurnEvent } from '../../types';

// Zero address for Tron (base58 format)
const ZERO_ADDRESS_HEX = '410000000000000000000000000000000000000000';
const ZERO_ADDRESS_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

// Max events per request
const MAX_EVENTS_PER_REQUEST = 200;

export class TronAdapter implements BlockchainAdapter {
  readonly chainType: ChainType = 'tron';

  private tronWeb: any = null;
  private rpcEndpoint: string = '';

  async connect(rpcEndpoint: string): Promise<void> {
    this.rpcEndpoint = rpcEndpoint;

    // TronWeb expects different endpoints for different services
    // For simplicity, we'll use the same endpoint for all
    this.tronWeb = new TronWeb({
      fullHost: rpcEndpoint,
    });

    // Test connection
    await this.tronWeb.trx.getCurrentBlock();
  }

  async disconnect(): Promise<void> {
    this.tronWeb = null;
  }

  isConnected(): boolean {
    return this.tronWeb !== null;
  }

  private getTronWeb(): any {
    if (!this.tronWeb) {
      throw new Error('Not connected. Call connect() first.');
    }
    return this.tronWeb;
  }

  async getCurrentBlockNumber(): Promise<number> {
    const block = await this.getTronWeb().trx.getCurrentBlock();
    return block.block_header.raw_data.number;
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.getTronWeb().trx.getBlock(blockNumber);
    // Tron timestamps are in milliseconds
    return Math.floor(block.block_header.raw_data.timestamp / 1000);
  }

  async getContractCreationBlock(address: string): Promise<number | null> {
    const tronWeb = this.getTronWeb();

    try {
      // Get contract info which includes creation time
      const contract = await tronWeb.trx.getContract(address);
      if (!contract || !contract.contract_address) {
        return null;
      }

      // Tron doesn't directly provide creation block, but we can estimate
      // from the contract's origin_energy_limit or query transaction history
      // For now, we'll start from a reasonable point
      // TODO: Implement better creation block detection using event API

      return null; // Will trigger fallback to search
    } catch {
      return null;
    }
  }

  async getTokenDecimals(address: string): Promise<number> {
    const tronWeb = this.getTronWeb();

    try {
      const contract = await tronWeb.contract().at(address);
      const decimals = await contract.decimals().call();
      return Number(decimals);
    } catch {
      return 6; // TRC20 tokens commonly use 6 decimals (like USDT)
    }
  }

  async getTotalSupply(address: string): Promise<string> {
    const tronWeb = this.getTronWeb();
    const contract = await tronWeb.contract().at(address);
    const supply = await contract.totalSupply().call();
    return supply.toString();
  }

  async getTransferEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    const tronWeb = this.getTronWeb();
    const events: TransferEvent[] = [];

    // Tron uses event API differently - we query by contract and event name
    // This may require TronGrid API for efficient historical queries

    try {
      // Get contract events
      const contract = await tronWeb.contract().at(address);

      // TronWeb event watching is different from EVM
      // We'll use the event query API
      let fingerprint: string | undefined = undefined;
      let hasMore = true;

      while (hasMore) {
        const eventResult: any = await tronWeb.event.getEventsByContractAddress(
          address,
          {
            eventName: 'Transfer',
            onlyConfirmed: true,
            size: MAX_EVENTS_PER_REQUEST,
            fingerprint,
          }
        );

        const eventData = eventResult.data || eventResult;
        if (!Array.isArray(eventData) || eventData.length === 0) {
          hasMore = false;
          break;
        }

        for (const event of eventData) {
          const blockNum = event.block_number;

          // Filter by block range
          if (blockNum < fromBlock) {
            hasMore = false;
            break;
          }
          if (blockNum > toBlock) continue;

          events.push({
            blockNumber: blockNum,
            txHash: event.transaction_id,
            from: tronWeb.address.fromHex(event.result.from || event.result[0]),
            to: tronWeb.address.fromHex(event.result.to || event.result[1]),
            value: (event.result.value || event.result[2]).toString(),
            timestamp: Math.floor(event.block_timestamp / 1000),
          });
        }

        // Get pagination fingerprint
        fingerprint = eventResult.meta?.fingerprint;
        if (!fingerprint) {
          hasMore = false;
        }
      }
    } catch (error) {
      console.error('Error fetching Tron transfer events:', error);
    }

    return events;
  }

  async getMintBurnEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<{ mints: MintEvent[]; burns: BurnEvent[] }> {
    const transfers = await this.getTransferEvents(address, fromBlock, toBlock);
    const tronWeb = this.getTronWeb();

    const mints: MintEvent[] = [];
    const burns: BurnEvent[] = [];

    for (const transfer of transfers) {
      // Check for zero address (mint source or burn destination)
      const fromHex = tronWeb.address.toHex(transfer.from);
      const toHex = tronWeb.address.toHex(transfer.to);

      if (fromHex === ZERO_ADDRESS_HEX || transfer.from === ZERO_ADDRESS_BASE58) {
        mints.push({
          blockNumber: transfer.blockNumber,
          txHash: transfer.txHash,
          to: transfer.to,
          value: transfer.value,
          timestamp: transfer.timestamp,
        });
      } else if (toHex === ZERO_ADDRESS_HEX || transfer.to === ZERO_ADDRESS_BASE58) {
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
    const tronWeb = this.getTronWeb();
    const txInfo = await tronWeb.trx.getTransactionInfo(txHash);

    if (!txInfo) {
      throw new Error(`Transaction ${txHash} not found`);
    }

    // Tron fees are in SUN (1 TRX = 1,000,000 SUN)
    const fee = txInfo.fee || 0;
    return {
      feeNative: fee.toString(),
      feeUsd: null,
    };
  }

  async getTransactionFees(txHashes: string[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>> {
    const results = new Map<string, { feeNative: string; feeUsd: string | null }>();

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

// Register the Tron adapter
registerAdapter('tron', async (rpcEndpoint: string) => {
  const adapter = new TronAdapter();
  await adapter.connect(rpcEndpoint);
  return adapter;
});

export default TronAdapter;
