import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  ConfirmedSignatureInfo,
} from '@solana/web3.js';
import { BlockchainAdapter, registerAdapter } from './base';
import { ChainType, TransferEvent, MintEvent, BurnEvent } from '../../types';

// SPL Token program ID
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Max signatures per request
const MAX_SIGNATURES_PER_REQUEST = 1000;

export class SolanaAdapter implements BlockchainAdapter {
  readonly chainType: ChainType = 'solana';

  private connection: Connection | null = null;
  private rpcEndpoint: string = '';

  async connect(rpcEndpoint: string): Promise<void> {
    this.rpcEndpoint = rpcEndpoint;
    this.connection = new Connection(rpcEndpoint, 'confirmed');

    // Test connection
    await this.connection.getSlot();
  }

  async disconnect(): Promise<void> {
    this.connection = null;
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  private getConnection(): Connection {
    if (!this.connection) {
      throw new Error('Not connected. Call connect() first.');
    }
    return this.connection;
  }

  async getCurrentBlockNumber(): Promise<number> {
    return this.getConnection().getSlot();
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.getConnection().getBlockTime(blockNumber);
    if (block === null) {
      throw new Error(`Block time for slot ${blockNumber} not found`);
    }
    return block;
  }

  async getContractCreationBlock(_address: string): Promise<number | null> {
    // Solana doesn't have contract creation in the same way as EVM
    // For SPL tokens, we'd need to find the initialize instruction
    // For now, return null and let the processor handle it
    return null;
  }

  async getTokenDecimals(address: string): Promise<number> {
    const connection = this.getConnection();
    const mintPubkey = new PublicKey(address);

    try {
      const accountInfo = await connection.getParsedAccountInfo(mintPubkey);
      if (accountInfo.value?.data && 'parsed' in accountInfo.value.data) {
        return accountInfo.value.data.parsed.info.decimals;
      }
    } catch (error) {
      console.warn(`Failed to get decimals for ${address}:`, error);
    }

    return 6; // USDC on Solana uses 6 decimals
  }

  async getTotalSupply(address: string): Promise<string> {
    const connection = this.getConnection();
    const mintPubkey = new PublicKey(address);

    const supplyInfo = await connection.getTokenSupply(mintPubkey);
    return supplyInfo.value.amount;
  }

  async getTransferEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    const connection = this.getConnection();
    const mintPubkey = new PublicKey(address);
    const events: TransferEvent[] = [];

    // Get all signatures for the mint account
    // This is expensive for large time ranges
    let beforeSignature: string | undefined = undefined;
    let keepFetching = true;

    while (keepFetching) {
      const signatures: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(
        mintPubkey,
        {
          before: beforeSignature,
          limit: MAX_SIGNATURES_PER_REQUEST,
        }
      );

      if (signatures.length === 0) {
        break;
      }

      for (const sig of signatures) {
        // Filter by slot (block) range
        if (sig.slot < fromBlock) {
          keepFetching = false;
          break;
        }
        if (sig.slot > toBlock) continue;

        try {
          const tx = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta) continue;

          // Parse transfer instructions
          const transfers = this.parseTransferInstructions(tx, address, sig.slot, sig.blockTime || 0);
          events.push(...transfers);
        } catch (error) {
          console.warn(`Failed to parse transaction ${sig.signature}:`, error);
        }
      }

      beforeSignature = signatures[signatures.length - 1].signature;

      if (signatures.length < MAX_SIGNATURES_PER_REQUEST) {
        keepFetching = false;
      }
    }

    return events;
  }

  private parseTransferInstructions(
    tx: ParsedTransactionWithMeta,
    mintAddress: string,
    slot: number,
    timestamp: number
  ): TransferEvent[] {
    const events: TransferEvent[] = [];

    if (!tx.transaction.message.instructions) return events;

    for (const instruction of tx.transaction.message.instructions) {
      if ('parsed' in instruction && instruction.program === 'spl-token') {
        const parsed = instruction.parsed;

        if (parsed.type === 'transfer' || parsed.type === 'transferChecked') {
          // For SPL transfers, we need to check if it's for our mint
          const info = parsed.info;

          events.push({
            blockNumber: slot,
            txHash: tx.transaction.signatures[0],
            from: info.source || info.authority || '',
            to: info.destination || '',
            value: info.amount || info.tokenAmount?.amount || '0',
            timestamp,
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
    const connection = this.getConnection();
    const mintPubkey = new PublicKey(address);
    const mints: MintEvent[] = [];
    const burns: BurnEvent[] = [];

    let beforeSignature: string | undefined = undefined;
    let keepFetching = true;

    while (keepFetching) {
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        before: beforeSignature,
        limit: MAX_SIGNATURES_PER_REQUEST,
      });

      if (signatures.length === 0) break;

      for (const sig of signatures) {
        if (sig.slot < fromBlock) {
          keepFetching = false;
          break;
        }
        if (sig.slot > toBlock) continue;

        try {
          const tx = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta) continue;

          // Parse mint/burn instructions
          for (const instruction of tx.transaction.message.instructions) {
            if ('parsed' in instruction && instruction.program === 'spl-token') {
              const parsed = instruction.parsed;

              if (parsed.type === 'mintTo' || parsed.type === 'mintToChecked') {
                mints.push({
                  blockNumber: sig.slot,
                  txHash: sig.signature,
                  to: parsed.info.account || parsed.info.destination || '',
                  value: parsed.info.amount || parsed.info.tokenAmount?.amount || '0',
                  timestamp: sig.blockTime || 0,
                });
              } else if (parsed.type === 'burn' || parsed.type === 'burnChecked') {
                burns.push({
                  blockNumber: sig.slot,
                  txHash: sig.signature,
                  from: parsed.info.account || parsed.info.source || '',
                  value: parsed.info.amount || parsed.info.tokenAmount?.amount || '0',
                  timestamp: sig.blockTime || 0,
                });
              }
            }
          }
        } catch (error) {
          console.warn(`Failed to parse transaction ${sig.signature}:`, error);
        }
      }

      beforeSignature = signatures[signatures.length - 1].signature;

      if (signatures.length < MAX_SIGNATURES_PER_REQUEST) {
        keepFetching = false;
      }
    }

    return { mints, burns };
  }

  async getTransactionFee(txHash: string): Promise<{ feeNative: string; feeUsd: string | null }> {
    const connection = this.getConnection();
    const tx = await connection.getParsedTransaction(txHash, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) {
      throw new Error(`Transaction ${txHash} not found`);
    }

    // Fee is in lamports (1 SOL = 1,000,000,000 lamports)
    const fee = tx.meta.fee;
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

// Register the Solana adapter
registerAdapter('solana', async (rpcEndpoint: string) => {
  const adapter = new SolanaAdapter();
  await adapter.connect(rpcEndpoint);
  return adapter;
});

export default SolanaAdapter;
