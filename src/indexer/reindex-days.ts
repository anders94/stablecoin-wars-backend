/**
 * Rebuild the metrics and block summaries for specific UTC days of one contract.
 *
 * Each day's block range is taken from its daily metrics row: from the previous day's
 * end_block + 1 through the day's own end_block. The day is re-fetched from the chain, then
 * a single transaction deletes the range's blocks (block_addresses cascade), the day's
 * metrics row and every aggregate covering it, and writes the fresh data. A day is
 * therefore either fully rebuilt or left untouched, so the script is safe to re-run.
 * sync_state is never touched, so this can run alongside the main indexer.
 *
 * Usage:
 *   ts-node src/indexer/reindex-days.ts <contract-id> <YYYY-MM-DD>... [--apply]
 * Without --apply it only prints each day's range and the rows it would replace.
 */
import dotenv from 'dotenv';
dotenv.config();

import { PoolClient } from 'pg';
import { createAdapter } from './adapters';
import { query, queryOne, transaction, closePool } from '../db';
import { RESOLUTIONS } from '../types';
import { RateLimitService } from './rateLimit';
import { fetchChunk, writeChunk, ChunkData } from './processor';

interface ContractConfig {
  id: string;
  contract_address: string;
  chain_type: 'evm' | 'tron' | 'solana';
  rpc_endpoint_id: string;
  rpc_endpoint: string;
  max_requests_per_second: number;
  max_blocks_per_query: number;
}

interface DayRange {
  day: string;
  fromBlock: number;
  toBlock: number;
}

const SECONDS_PER_DAY = 86400;

async function getDayRange(contractId: string, day: string): Promise<DayRange> {
  const row = await queryOne<{ end_block: string }>(
    `SELECT end_block FROM metrics
     WHERE contract_id = $1 AND resolution_seconds = $2 AND period_start = $3::date`,
    [contractId, RESOLUTIONS.DAY, day]
  );
  if (!row) {
    throw new Error(`No daily metrics row for ${day}`);
  }
  const prev = await queryOne<{ end_block: string }>(
    `SELECT end_block FROM metrics
     WHERE contract_id = $1 AND resolution_seconds = $2 AND period_start < $3::date
     ORDER BY period_start DESC LIMIT 1`,
    [contractId, RESOLUTIONS.DAY, day]
  );
  if (!prev) {
    throw new Error(`No daily metrics row before ${day} to bound its range`);
  }
  return { day, fromBlock: Number(prev.end_block) + 1, toBlock: Number(row.end_block) };
}

// Aggregates covering the day: any coarser period whose [period_start, period_start + resolution) contains it
const AGGREGATES_COVERING_DAY = `
  contract_id = $1 AND resolution_seconds > $2
  AND period_start <= $3::date
  AND period_start + resolution_seconds * interval '1 second' > $3::date`;

async function countRows(contractId: string, range: DayRange) {
  const [blocks] = await query<{ count: string }>(
    'SELECT count(*) FROM blocks WHERE contract_id = $1 AND block_number BETWEEN $2 AND $3',
    [contractId, range.fromBlock, range.toBlock]
  );
  const [aggregates] = await query<{ count: string }>(
    `SELECT count(*) FROM metrics WHERE ${AGGREGATES_COVERING_DAY}`,
    [contractId, RESOLUTIONS.DAY, range.day]
  );
  return { blocks: Number(blocks.count), aggregates: Number(aggregates.count) };
}

async function replaceDay(client: PoolClient, contractId: string, range: DayRange, chunks: [number, number, ChunkData][]) {
  await client.query('SET LOCAL statement_timeout = 0');
  const blocks = await client.query(
    'DELETE FROM blocks WHERE contract_id = $1 AND block_number BETWEEN $2 AND $3',
    [contractId, range.fromBlock, range.toBlock]
  );
  await client.query(
    'DELETE FROM metrics WHERE contract_id = $1 AND resolution_seconds = $2 AND period_start = $3::date',
    [contractId, RESOLUTIONS.DAY, range.day]
  );
  const aggregates = await client.query(
    `DELETE FROM metrics WHERE ${AGGREGATES_COVERING_DAY}`,
    [contractId, RESOLUTIONS.DAY, range.day]
  );
  for (const [from, to, chunk] of chunks) {
    await writeChunk(client, contractId, chunk, from, to);
  }
  // The rebuilt range must reproduce the day's row with the same end block, or the range was wrong
  const rebuilt = await client.query<{ end_block: string }>(
    'SELECT end_block FROM metrics WHERE contract_id = $1 AND resolution_seconds = $2 AND period_start = $3::date',
    [contractId, RESOLUTIONS.DAY, range.day]
  );
  if (Number(rebuilt.rows[0]?.end_block) !== range.toBlock) {
    throw new Error(`Rebuilt ${range.day} ends at block ${rebuilt.rows[0]?.end_block}, expected ${range.toBlock}; rolling back`);
  }
  console.log(`  replaced ${blocks.rowCount} blocks, removed ${aggregates.rowCount} aggregates`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [contractId, ...days] = args.filter(a => a !== '--apply');
  if (!contractId || days.length === 0 || days.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
    console.error('Usage: ts-node src/indexer/reindex-days.ts <contract-id> <YYYY-MM-DD>... [--apply]');
    process.exit(1);
  }
  days.sort();

  const contract = await queryOne<ContractConfig>(
    `SELECT c.id, c.contract_address, n.chain_type,
            re.id as rpc_endpoint_id, re.url as rpc_endpoint, re.max_requests_per_second, re.max_blocks_per_query
     FROM contracts c
     JOIN networks n ON c.network_id = n.id
     JOIN rpc_endpoints re ON c.rpc_endpoint_id = re.id
     WHERE c.id = $1`,
    [contractId]
  );
  if (!contract) {
    throw new Error(`Contract ${contractId} not found`);
  }

  const ranges: DayRange[] = [];
  for (const day of days) {
    ranges.push(await getDayRange(contractId, day));
  }

  let totalBlocks = 0;
  for (const range of ranges) {
    const counts = await countRows(contractId, range);
    const size = range.toBlock - range.fromBlock + 1;
    totalBlocks += size;
    console.log(`${range.day}: blocks ${range.fromBlock}-${range.toBlock} (${size}), ${counts.blocks} block rows, ${counts.aggregates} aggregates`);
  }
  console.log(`${ranges.length} days, ${totalBlocks} blocks`);
  if (!apply) {
    console.log('Dry run; pass --apply to rebuild');
    return;
  }

  const rateLimiter = new RateLimitService();
  const adapter = await createAdapter(contract.chain_type, contract.rpc_endpoint, {
    rateLimiter,
    endpointId: contract.rpc_endpoint_id,
    maxRequestsPerSecond: contract.max_requests_per_second,
  });

  try {
    for (const [i, range] of ranges.entries()) {
      console.log(`[${i + 1}/${ranges.length}] ${range.day}: fetching blocks ${range.fromBlock}-${range.toBlock}`);
      const dayStart = Date.parse(`${range.day}T00:00:00Z`) / 1000;

      const chunks: [number, number, ChunkData][] = [];
      for (let from = range.fromBlock; from <= range.toBlock; from += contract.max_blocks_per_query) {
        const to = Math.min(from + contract.max_blocks_per_query - 1, range.toBlock);
        const chunk = await fetchChunk(adapter, contract.contract_address, from, to);
        // Every event in the range must belong to this day, or neighbouring days would be changed too
        const stray = [...chunk.transfers, ...chunk.mints, ...chunk.burns]
          .find(e => e.timestamp < dayStart || e.timestamp >= dayStart + SECONDS_PER_DAY);
        if (stray) {
          throw new Error(`Block ${stray.blockNumber} in ${range.day}'s range has timestamp ${stray.timestamp} outside the day`);
        }
        chunks.push([from, to, chunk]);
      }

      await transaction(client => replaceDay(client, contractId, range, chunks));
    }
  } finally {
    await adapter.disconnect();
    await rateLimiter.close();
  }
  console.log('Done');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
