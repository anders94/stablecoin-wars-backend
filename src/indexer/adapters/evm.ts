import { ethers, Contract, Provider, JsonRpcProvider, toQuantity } from 'ethers';
import { BlockchainAdapter, registerAdapter } from './base';
import { ChainType, TransferEvent, MintEvent, BurnEvent, ContractEvents, ContractLogEvent, ContractEventsOptions } from '../../types';
import { EventSet, EventDefinition, getEventSet } from '../eventSets';
import { isShutdownRequested } from '../shutdown';
import { RateLimitService } from '../rateLimit';
import { StatusLineReporter } from '../statusLineReporter';

// Standard ERC20 ABI for Transfer events and basic functions
const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const TRANSFER_IFACE = new ethers.Interface([ERC20_ABI[0]]);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer')!.topicHash;

// Interface and topic0 -> definition for each event set, built once
const eventSetInterfaces = new Map<string, { iface: ethers.Interface; definitions: Map<string, EventDefinition> }>();

function getEventSetInterface(eventSet: EventSet) {
  let entry = eventSetInterfaces.get(eventSet.name);
  if (!entry) {
    const iface = new ethers.Interface(eventSet.events.map(e => e.abi));
    const definitions = new Map<string, EventDefinition>();
    for (const definition of eventSet.events) {
      const fragment = ethers.EventFragment.from(definition.abi.replace(/^event /, ''));
      definitions.set(fragment.topicHash, definition);
    }
    entry = { iface, definitions };
    eventSetInterfaces.set(eventSet.name, entry);
  }
  return entry;
}

function argValue(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : String(value);
}

/**
 * Decode one of an event set's logs. A log whose layout does not match the ABI (e.g. an older
 * implementation indexed an argument differently) is kept with its raw topics and data.
 */
function decodeContractLog(
  iface: ethers.Interface,
  definition: EventDefinition,
  log: RawLog,
  timestamp: number
): ContractLogEvent {
  const eventName = ethers.EventFragment.from(definition.abi.replace(/^event /, '')).name;
  let args: Record<string, string> | null = null;
  try {
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (parsed) {
      args = {};
      parsed.fragment.inputs.forEach((input: ethers.ParamType, i: number) => {
        args![input.name || `arg${i}`] = argValue(parsed.args[i]);
      });
    }
  } catch {
    args = null;
  }
  return {
    blockNumber: log.blockNumber,
    logIndex: log.index,
    txHash: log.transactionHash,
    timestamp,
    eventName,
    category: definition.category,
    supply: definition.supply,
    from: args && definition.fromArg ? args[definition.fromArg] ?? null : null,
    to: args && definition.toArg ? args[definition.toArg] ?? null : null,
    amount: args && definition.amountArg ? args[definition.amountArg] ?? null : null,
    args: args ?? { raw_topics: log.topics.join(','), raw_data: log.data },
  };
}

// The parts of a log the adapter uses, from either ethers' getLogs or raw JSON-RPC. Raw logs
// carry the block timestamp when the node returns it (Erigon and recent geth do).
type RawLog = Pick<ethers.Log, 'blockNumber' | 'blockHash' | 'index' | 'transactionHash' | 'topics' | 'data'> & { timestamp?: number };

// Zero address for detecting mints/burns
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Max block range for getLogs (varies by RPC provider)
const MAX_BLOCK_RANGE = 10000;

// Transaction receipt retry settings
const MAX_RECEIPT_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 500;
// Below this many of our transactions per block on average, fetch receipts one by one instead
const MIN_TXS_PER_BLOCK_FOR_BLOCK_RECEIPTS = 4;
// Block timestamp lookups in flight at once while fetching transfer events
const TIMESTAMP_FETCH_CONCURRENCY = 8;
// Successful full-span getLogs queries before trying a span twice as large
const LOG_SPAN_GROW_AFTER = 20;
// owner() selector, for contracts whose supply events implicitly credit the owner
const OWNER_SELECTOR = '0x8da5cb5b';

type FeeMap = Map<string, { feeNative: string; feeUsd: string | null }>;

// Block receipts fetched recently, shared by every adapter instance in the process: the live
// sync fetches the same blocks for each contract on a chain, one contract after another
const RECEIPT_CACHE_MAX_BLOCKS = 4000;
const RECEIPT_CACHE_TTL_MS = 30 * 60 * 1000;
const receiptCache = new Map<string, { fees: FeeMap; at: number }>();

function cachedBlockFees(key: string): FeeMap | null {
  const hit = receiptCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RECEIPT_CACHE_TTL_MS) {
    receiptCache.delete(key);
    return null;
  }
  return hit.fees;
}

function cacheBlockFees(key: string, fees: FeeMap): void {
  receiptCache.set(key, { fees, at: Date.now() });
  // Maps iterate in insertion order, so the first keys are the oldest
  while (receiptCache.size > RECEIPT_CACHE_MAX_BLOCKS) {
    receiptCache.delete(receiptCache.keys().next().value!);
  }
}

// Helper function to sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Detect the "too many logs" style error that execution clients return when an
// eth_getLogs query would exceed the node's response cap. The cap is by result
// COUNT (e.g. 20000 logs), not by block count, so block-based chunking alone
// cannot guarantee a query fits — we detect this and bisect the range instead.
// Different clients phrase this differently (geth/erigon/nethermind/providers).
function isTooManyLogsError(error: unknown): boolean {
  const msg = ((error as Error)?.message || String(error)).toLowerCase();
  return (
    msg.includes('too many logs') ||
    msg.includes('query returned more than') ||
    msg.includes('response size exceed') ||
    msg.includes('log response size exceeded') ||
    (msg.includes('more than') && msg.includes('results')) ||
    (msg.includes('exceed') && msg.includes('limit'))
  );
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
// Historical getLogs on a node that recomputes receipts can take well over a minute
const LONG_RPC_TIMEOUT_MS = 180000;

export class EVMAdapter implements BlockchainAdapter {
  readonly chainType: ChainType = 'evm';

  private provider: JsonRpcProvider | null = null;
  private rpcEndpoint: string = '';
  private rateLimiter: RateLimitService | null = null;
  private endpointId: string | null = null;
  private maxRequestsPerSecond: number | null = null;
  // Largest getLogs block span to try, learned from the node's result cap (see fetchTransferLogs)
  private logSpan = MAX_BLOCK_RANGE;
  private logSpanSuccesses = 0;

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
      // ethers returns uint8 results as bigint
      return Number(await withTimeout(
        contract.decimals(),
        RPC_TIMEOUT_MS,
        `getTokenDecimals ${address}`
      ));
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

  async getOwnerAt(address: string, blockNumber: number): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.acquireRateLimitToken(`eth_call (owner ${address} @${blockNumber})`);
        const result = await withTimeout(
          this.getProvider().send('eth_call', [{ to: address, data: OWNER_SELECTOR }, toQuantity(blockNumber)]) as Promise<string>,
          RPC_TIMEOUT_MS,
          `owner ${address} @${blockNumber}`
        );
        // An address is the low 20 bytes of the 32-byte word; anything else means no owner()
        return result && result.length === 66 ? '0x' + result.slice(26).toLowerCase() : null;
      } catch (error) {
        if (attempt >= MAX_RECEIPT_RETRIES - 1 || isShutdownRequested()) throw error;
        await sleep(INITIAL_RETRY_DELAY_MS * 2 ** attempt);
      }
    }
  }

  // Fetch logs for a block range in pieces that stay under the node's result cap.
  // Erigon scans the whole range before rejecting an over-cap query (several seconds for a busy
  // token), so rather than trying the full range every time, remember the span that last fit:
  // halve it on a cap hit, and only try doubling it after a run of successful queries.
  private async fetchLogs(
    address: string,
    topic0s: string[],
    fromBlock: number,
    toBlock: number,
    label: string
  ): Promise<RawLog[]> {
    const provider = this.getProvider();
    const logs: RawLog[] = [];
    let start = fromBlock;
    while (start <= toBlock) {
      const end = Math.min(start + this.logSpan - 1, toBlock);
      await this.acquireRateLimitToken(`eth_getLogs (${label} ${start}-${end})`);
      try {
        logs.push(...await withTimeout(
          provider.getLogs({ address, topics: [topic0s], fromBlock: start, toBlock: end }),
          RPC_TIMEOUT_MS,
          `getLogs ${label} ${start}-${end}`
        ));
      } catch (error) {
        if (isTooManyLogsError(error) && start < end) {
          this.logSpan = Math.max(1, Math.floor((end - start + 1) / 2));
          this.logSpanSuccesses = 0;
          StatusLineReporter.getInstance().log(
            `  eth_getLogs cap hit for ${start}-${end}, using ${this.logSpan}-block queries`
          );
          continue;
        }
        throw error;
      }
      // Only queries that used the whole span say anything about whether a larger one would fit
      const usedFullSpan = end - start + 1 >= this.logSpan;
      start = end + 1;
      if (usedFullSpan && ++this.logSpanSuccesses >= LOG_SPAN_GROW_AFTER && this.logSpan < MAX_BLOCK_RANGE) {
        this.logSpan = Math.min(this.logSpan * 2, MAX_BLOCK_RANGE);
        this.logSpanSuccesses = 0;
      }
    }
    return logs;
  }

  // Fetch logs for exactly [fromBlock, toBlock] in one query, halving the range only if the node
  // rejects it for returning too many logs. Unlike fetchLogs it keeps no span state, so callers
  // that size their own ranges (the event backfill) are not affected by each other.
  private async fetchLogsBisecting(
    address: string,
    topic0s: string[] | null,
    fromBlock: number,
    toBlock: number,
    label: string
  ): Promise<RawLog[]> {
    await this.acquireRateLimitToken(`eth_getLogs (${label} ${fromBlock}-${toBlock})`);
    try {
      // Raw JSON-RPC: ethers' getLogs builds a formatted Log object per log (checksummed
      // addresses etc.), which for 15k logs blocks the event loop for over a second
      // A null topic list fetches every log the contract emitted
      const filter = topic0s
        ? { address, topics: [topic0s], fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock) }
        : { address, fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock) };
      const raw = await withTimeout(
        this.getProvider().send('eth_getLogs', [filter]),
        LONG_RPC_TIMEOUT_MS,
        `getLogs ${label} ${fromBlock}-${toBlock}`
      ) as { blockNumber: string; blockHash: string; logIndex: string; transactionHash: string; topics: string[]; data: string; removed?: boolean; blockTimestamp?: string }[];
      return raw.filter(l => !l.removed).map(l => ({
        blockNumber: parseInt(l.blockNumber, 16),
        blockHash: l.blockHash,
        index: parseInt(l.logIndex, 16),
        transactionHash: l.transactionHash,
        topics: l.topics,
        data: l.data,
        timestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : undefined,
      }));
    } catch (error) {
      if (!isTooManyLogsError(error) || fromBlock >= toBlock) {
        throw error;
      }
      const mid = Math.floor((fromBlock + toBlock) / 2);
      return [
        ...await this.fetchLogsBisecting(address, topic0s, fromBlock, mid, label),
        ...await this.fetchLogsBisecting(address, topic0s, mid + 1, toBlock, label),
      ];
    }
  }

  // Timestamps of the blocks the logs are in. Many logs share a block, so each block is
  // fetched only once, several at a time.
  private async fetchLogTimestamps(logs: RawLog[]): Promise<Map<string, number>> {
    const provider = this.getProvider();
    const timestamps = new Map<string, number>();
    const blockHashes = [...new Set(logs.map(log => log.blockHash))];
    let next = 0;
    const fetchTimestamps = async () => {
      while (next < blockHashes.length) {
        const blockHash = blockHashes[next++];
        await this.acquireRateLimitToken(`eth_getBlockByHash (${blockHash.slice(0, 10)}...)`);
        const block = await withTimeout(
          provider.getBlock(blockHash),
          RPC_TIMEOUT_MS,
          `getBlock ${blockHash}`
        );
        if (!block) {
          throw new Error(`Block ${blockHash} not found`);
        }
        timestamps.set(blockHash, block.timestamp);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TIMESTAMP_FETCH_CONCURRENCY, blockHashes.length) }, fetchTimestamps)
    );
    return timestamps;
  }

  async getTransferEvents(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<TransferEvent[]> {
    const { transfers } = await this.getContractEvents(address, fromBlock, toBlock, getEventSet('erc20'));
    return transfers;
  }

  /**
   * Fetch Transfer logs together with the event set's other logs in one getLogs query per span.
   * Transfer addresses are checksummed; decoded arguments of
   * other events are lowercased. Without timestamps (opts.timestamps === false) every event's
   * timestamp is 0 and the caller fills it in.
   */
  async getContractEvents(
    address: string,
    fromBlock: number,
    toBlock: number,
    eventSet: EventSet,
    opts: ContractEventsOptions = {}
  ): Promise<ContractEvents> {
    const { iface, definitions } = getEventSetInterface(eventSet);
    const topic0s = [TRANSFER_TOPIC, ...definitions.keys()];
    const transfers: TransferEvent[] = [];
    const others: ContractLogEvent[] = [];
    const unknownTopics = opts.allTopics ? new Map<string, number>() : undefined;
    if (opts.allTopics && !opts.exactRange) {
      throw new Error('allTopics requires exactRange');
    }

    // Process in chunks to avoid RPC limits
    for (let start = fromBlock; start <= toBlock; start += MAX_BLOCK_RANGE) {
      // Check for shutdown request
      if (isShutdownRequested()) {
        console.log('  Shutdown requested, stopping event fetch');
        break;
      }

      const end = opts.exactRange ? toBlock : Math.min(start + MAX_BLOCK_RANGE - 1, toBlock);
      const label = eventSet.name === 'erc20' ? 'Transfer' : 'events';
      const logs = opts.exactRange
        ? await this.fetchLogsBisecting(address, opts.allTopics ? null : topic0s, start, end, label)
        : await this.fetchLogs(address, topic0s, start, end, label);
      // Timestamps the node returned with the logs are used as they are; blocks only for the rest
      const untimed = logs.filter(log => log.timestamp === undefined);
      const timestamps = opts.timestamps === false || untimed.length === 0 ? null : await this.fetchLogTimestamps(untimed);

      for (const log of logs) {
        const timestamp = log.timestamp ?? (timestamps ? timestamps.get(log.blockHash)! : 0);
        const topic0 = log.topics[0];
        if (topic0 === TRANSFER_TOPIC) {
          // Decoded by hand: ethers' parseLog costs ~65us per log, which blocks the event loop
          // for seconds on busy ranges. Logs sharing the Transfer signature with different
          // indexing (not from, to, value) are skipped.
          if (log.topics.length === 3 && log.data.length === 66) {
            const from = '0x' + log.topics[1].slice(26);
            const to = '0x' + log.topics[2].slice(26);
            transfers.push({
              blockNumber: log.blockNumber,
              logIndex: log.index,
              txHash: log.transactionHash,
              from: opts.lowercaseAddresses ? from : ethers.getAddress(from),
              to: opts.lowercaseAddresses ? to : ethers.getAddress(to),
              value: BigInt(log.data).toString(),
              timestamp,
            });
          }
          continue;
        }

        const definition = definitions.get(topic0);
        if (!definition) {
          if (unknownTopics) {
            const key = topic0 ?? '(anonymous)';
            unknownTopics.set(key, (unknownTopics.get(key) ?? 0) + 1);
          }
          continue;
        }
        others.push(decodeContractLog(iface, definition, log, timestamp));
      }
    }

    return { transfers, others, unknownTopics };
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

  /**
   * Fees for every transaction in a block, from a single eth_getBlockReceipts call.
   * Retries with backoff like getTransactionFee and throws once retries are exhausted.
   */
  async getBlockFees(blockNumber: number): Promise<FeeMap> {
    return this.getBlockReceiptFees(blockNumber);
  }

  private async getBlockReceiptFees(blockNumber: number): Promise<FeeMap> {
    const cacheKey = `${this.rpcEndpoint}|${blockNumber}`;
    const cached = cachedBlockFees(cacheKey);
    if (cached) {
      return cached;
    }
    const provider = this.getProvider();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RECEIPT_RETRIES; attempt++) {
      if (isShutdownRequested()) {
        throw new Error('Shutdown requested');
      }

      try {
        await this.acquireRateLimitToken(`eth_getBlockReceipts (${blockNumber})`);
        const receipts = await withTimeout(
          provider.send('eth_getBlockReceipts', [toQuantity(blockNumber)]) as Promise<
            { transactionHash: string; gasUsed: string; effectiveGasPrice: string }[] | null
          >,
          RPC_TIMEOUT_MS,
          `getBlockReceipts ${blockNumber}`
        );
        if (!receipts) {
          throw new Error(`Block ${blockNumber} receipts not found`);
        }

        const fees = new Map<string, { feeNative: string; feeUsd: string | null }>();
        for (const receipt of receipts) {
          // Same fee as getTransactionFee: ethers' receipt.gasPrice is the effectiveGasPrice field
          const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
          fees.set(receipt.transactionHash.toLowerCase(), { feeNative: fee.toString(), feeUsd: null });
        }
        cacheBlockFees(cacheKey, fees);
        return fees;
      } catch (error) {
        lastError = error as Error;
        if (attempt < MAX_RECEIPT_RETRIES - 1) {
          const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.log(`  Error fetching receipts for block ${blockNumber}: ${lastError.message}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RECEIPT_RETRIES})...`);
          await sleep(delayMs);
        }
      }
    }

    throw lastError || new Error(`Receipts for block ${blockNumber} not found after ${MAX_RECEIPT_RETRIES} attempts`);
  }

  async getTransactionFees(
    txHashes: string[],
    blockNumbers?: number[]
  ): Promise<Map<string, { feeNative: string; feeUsd: string | null }>> {
    // A block's receipts cost about as much as a few single receipts (more for old blocks, which
    // the node may re-execute), so only fetch whole blocks when they hold enough of our txs
    if (!blockNumbers || blockNumbers.length === 0 ||
        txHashes.length < blockNumbers.length * MIN_TXS_PER_BLOCK_FOR_BLOCK_RECEIPTS) {
      return this.getTransactionFeesOneByOne(txHashes);
    }

    // One eth_getBlockReceipts call per block instead of one receipt call per transaction
    const blockFees = new Map<string, { feeNative: string; feeUsd: string | null }>();
    const batchSize = 5;
    for (let i = 0; i < blockNumbers.length; i += batchSize) {
      if (isShutdownRequested()) {
        console.log('  Shutdown requested, stopping transaction fee fetch');
        break;
      }

      await Promise.all(blockNumbers.slice(i, i + batchSize).map(async (blockNumber) => {
        try {
          for (const [txHash, fee] of await this.getBlockReceiptFees(blockNumber)) {
            blockFees.set(txHash, fee);
          }
        } catch (error) {
          // Its transactions are picked up one by one below
          console.error(`Failed to get receipts for block ${blockNumber}: ${(error as Error).message}`);
        }
      }));
    }

    const results = new Map<string, { feeNative: string; feeUsd: string | null }>();
    const missing: string[] = [];
    for (const txHash of txHashes) {
      const fee = blockFees.get(txHash.toLowerCase());
      if (fee) {
        results.set(txHash, fee);
      } else {
        missing.push(txHash);
      }
    }

    // Anything not covered (a failed block, or a hash outside the given blocks) goes one by one
    if (missing.length > 0 && !isShutdownRequested()) {
      console.log(`  Fetching ${missing.length} receipts individually`);
      for (const [txHash, fee] of await this.getTransactionFeesOneByOne(missing)) {
        results.set(txHash, fee);
      }
    }

    return results;
  }

  private async getTransactionFeesOneByOne(txHashes: string[]): Promise<Map<string, { feeNative: string; feeUsd: string | null }>> {
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
