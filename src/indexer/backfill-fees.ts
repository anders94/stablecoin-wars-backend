import { query, queryOne } from '../db';
import { RateLimitService } from './rateLimit';
import { createAdapter } from './adapters';
import { Contract, Block, ChainType } from '../types';

const BATCH_SIZE = 100; // Process 100 blocks at a time

async function main() {
  console.log('Starting fee backfill for blocks with mints/burns...');

  const rateLimitService = new RateLimitService({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
  });

  try {
    // Get all contracts
    const contracts = await query<Contract>('SELECT * FROM contracts WHERE is_active = true');

    for (const contract of contracts) {
      console.log(`\nProcessing contract: ${contract.contract_address} on network ${contract.network_id}`);

      // Find blocks with mints or burns that likely need fixing
      // These are blocks where (minted > 0 OR burned > 0) but tx_count = 0
      const blocksToFix = await query<Block>(
        `SELECT * FROM blocks
         WHERE contract_id = $1
           AND (minted::numeric > 0 OR burned::numeric > 0)
           AND tx_count = 0
         ORDER BY block_number`,
        [contract.id]
      );

      console.log(`Found ${blocksToFix.length} blocks to backfill`);

      if (blocksToFix.length === 0) {
        continue;
      }

      // Get network info
      const network = await queryOne<{ chain_type: string }>(
        'SELECT chain_type FROM networks WHERE id = $1',
        [contract.network_id]
      );

      if (!network) {
        console.error(`Network not found for contract ${contract.id}`);
        continue;
      }

      // Get RPC endpoint
      const rpcEndpoint = await queryOne<{ id: string; url: string; max_requests_per_second: number }>(
        'SELECT id, url, max_requests_per_second FROM rpc_endpoints WHERE id = $1',
        [contract.rpc_endpoint_id]
      );

      if (!rpcEndpoint) {
        console.error(`RPC endpoint not found for contract ${contract.id}`);
        continue;
      }

      // Create adapter
      const adapter = await createAdapter(
        network.chain_type as ChainType,
        rpcEndpoint.url,
        {
          rateLimiter: rateLimitService,
          endpointId: rpcEndpoint.id,
          maxRequestsPerSecond: rpcEndpoint.max_requests_per_second,
        }
      );

      // Process blocks in batches
      for (let i = 0; i < blocksToFix.length; i += BATCH_SIZE) {
        const batch = blocksToFix.slice(i, i + BATCH_SIZE);
        const startBlock = parseInt(batch[0].block_number.toString());
        const endBlock = parseInt(batch[batch.length - 1].block_number.toString());

        console.log(`  [${i + 1}/${blocksToFix.length}] Processing blocks ${startBlock} to ${endBlock}...`);

        // Get mint/burn events for this block range
        const { mints, burns } = await adapter.getMintBurnEvents(
          contract.contract_address,
          startBlock,
          endBlock
        );

        // Collect all transaction hashes
        const txHashes = new Set<string>();
        const blockTxMap = new Map<number, string[]>();

        for (const mint of mints) {
          txHashes.add(mint.txHash);
          if (!blockTxMap.has(mint.blockNumber)) {
            blockTxMap.set(mint.blockNumber, []);
          }
          blockTxMap.get(mint.blockNumber)!.push(mint.txHash);
        }

        for (const burn of burns) {
          txHashes.add(burn.txHash);
          if (!blockTxMap.has(burn.blockNumber)) {
            blockTxMap.set(burn.blockNumber, []);
          }
          blockTxMap.get(burn.blockNumber)!.push(burn.txHash);
        }

        // Get transaction fees
        let fees = new Map<string, { feeNative: string; feeUsd: string | null }>();
        if (txHashes.size > 0) {
          fees = await adapter.getTransactionFees(Array.from(txHashes));
        }

        // Update each block
        for (const block of batch) {
          const blockNumber = parseInt(block.block_number.toString());
          const blockTxs = blockTxMap.get(blockNumber) || [];
          const txCount = blockTxs.length;

          let totalFeesNative = BigInt(0);
          for (const txHash of blockTxs) {
            const fee = fees.get(txHash);
            if (fee) {
              totalFeesNative += BigInt(fee.feeNative);
            }
          }

          // Update the block
          await query(
            `UPDATE blocks
             SET tx_count = tx_count + $1,
                 total_fees_native = total_fees_native + $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [txCount, totalFeesNative.toString(), block.id]
          );
        }

        console.log(`  ✓ Updated ${batch.length} blocks with fees and tx counts`);
      }

      console.log(`✓ Completed contract ${contract.contract_address}`);
    }

    console.log('\n✓ Backfill complete!');
  } catch (error) {
    console.error('Error during backfill:', error);
    process.exit(1);
  } finally {
    await rateLimitService.close();
    process.exit(0);
  }
}

main();
