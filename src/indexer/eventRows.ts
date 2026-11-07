import { PoolClient } from 'pg';
import { ContractLogEvent, TransferEvent, MintEvent, BurnEvent } from '../types';

const EVM_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const INSERT_BATCH_SIZE = 5000;

export interface EventRow {
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  kind: 'transfer' | 'mint' | 'burn' | 'admin';
  eventName: string;
  category: string | null;
  from: string | null;
  to: string | null;
  amount: string | null;
  args: Record<string, string> | null;
  txFeeNative: string | null;
}

export interface EventSource {
  transfers: TransferEvent[];
  // Mints and burns split out of zero-address Transfers
  mints: MintEvent[];
  burns: BurnEvent[];
  // The event set's other logs
  others: ContractLogEvent[];
}

// EVM addresses are stored lowercased so lookups don't depend on checksum casing; other
// chains' addresses (base58) are case-sensitive and kept as they are
export function normalizeAddress(address: string | null | undefined): string | null {
  if (!address) {
    return null;
  }
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;
}

/**
 * Split zero-address Transfers into mints and burns, keeping them out of transfers so they
 * are not double counted.
 */
export function splitTransfers(allTransfers: TransferEvent[]): { transfers: TransferEvent[]; mints: MintEvent[]; burns: BurnEvent[] } {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const isZero = (a: string) => a.toLowerCase() === ZERO_ADDRESS;
  const mints = allTransfers
    .filter(t => isZero(t.from))
    .map(t => ({ blockNumber: t.blockNumber, logIndex: t.logIndex, txHash: t.txHash, to: t.to, value: t.value, timestamp: t.timestamp }));
  const burns = allTransfers
    .filter(t => !isZero(t.from) && isZero(t.to))
    .map(t => ({ blockNumber: t.blockNumber, logIndex: t.logIndex, txHash: t.txHash, from: t.from, value: t.value, timestamp: t.timestamp }));
  const transfers = allTransfers.filter(t => !isZero(t.from) && !isZero(t.to));
  return { transfers, mints, burns };
}

/**
 * Turn a fetched range's events into rows for the events table. Events without a log index
 * (adapters that cannot provide one) get their position among the block's events instead.
 */
export function buildEventRows(
  source: EventSource,
  fees?: Map<string, { feeNative: string }>
): EventRow[] {
  const fee = (txHash: string) => fees?.get(txHash)?.feeNative ?? null;
  const rows: (EventRow & { hasLogIndex: boolean })[] = [];

  for (const t of source.transfers) {
    rows.push({
      timestamp: t.timestamp, blockNumber: t.blockNumber, logIndex: t.logIndex ?? -1, hasLogIndex: t.logIndex !== undefined,
      txHash: t.txHash, kind: 'transfer', eventName: 'Transfer', category: null,
      from: normalizeAddress(t.from), to: normalizeAddress(t.to), amount: t.value, args: null, txFeeNative: fee(t.txHash),
    });
  }
  for (const m of source.mints) {
    rows.push({
      timestamp: m.timestamp, blockNumber: m.blockNumber, logIndex: m.logIndex ?? -1, hasLogIndex: m.logIndex !== undefined,
      txHash: m.txHash, kind: 'mint', eventName: 'Transfer', category: null,
      from: EVM_ZERO_ADDRESS, to: normalizeAddress(m.to), amount: m.value, args: null, txFeeNative: fee(m.txHash),
    });
  }
  for (const b of source.burns) {
    rows.push({
      timestamp: b.timestamp, blockNumber: b.blockNumber, logIndex: b.logIndex ?? -1, hasLogIndex: b.logIndex !== undefined,
      txHash: b.txHash, kind: 'burn', eventName: 'Transfer', category: null,
      from: normalizeAddress(b.from), to: EVM_ZERO_ADDRESS, amount: b.value, args: null, txFeeNative: fee(b.txHash),
    });
  }
  for (const e of source.others) {
    rows.push({
      timestamp: e.timestamp, blockNumber: e.blockNumber, logIndex: e.logIndex, hasLogIndex: true,
      txHash: e.txHash, kind: e.supply ?? 'admin', eventName: e.eventName, category: e.category,
      from: normalizeAddress(e.from), to: normalizeAddress(e.to), amount: e.amount, args: e.args, txFeeNative: fee(e.txHash),
    });
  }

  // Fill in missing log indexes per block, after any real ones
  if (rows.some(r => !r.hasLogIndex)) {
    const nextIndex = new Map<number, number>();
    for (const r of rows) {
      if (r.hasLogIndex) {
        nextIndex.set(r.blockNumber, Math.max(nextIndex.get(r.blockNumber) ?? 0, r.logIndex + 1));
      }
    }
    for (const r of rows) {
      if (!r.hasLogIndex) {
        const i = nextIndex.get(r.blockNumber) ?? 0;
        r.logIndex = i;
        nextIndex.set(r.blockNumber, i + 1);
      }
    }
  }

  return rows.map(({ hasLogIndex: _hasLogIndex, ...row }) => row);
}

/**
 * Insert event rows, skipping any already stored (the live sync and the backfill may overlap).
 * Returns the number of rows inserted.
 */
export async function insertEventRows(client: PoolClient, contractId: string, rows: EventRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const result = await client.query(
      `INSERT INTO events (
         contract_id, timestamp, block_number, log_index, tx_hash, kind, event_name, category,
         from_address, to_address, amount, args, tx_fee_native
       )
       SELECT $1, to_timestamp(ts) AT TIME ZONE 'UTC', bn, li, tx, kind, name, cat, fa, ta, amt::numeric, args::jsonb, fee::numeric
       FROM unnest(
         $2::double precision[], $3::bigint[], $4::integer[], $5::text[], $6::text[], $7::text[], $8::text[],
         $9::text[], $10::text[], $11::text[], $12::text[], $13::text[]
       ) AS u(ts, bn, li, tx, kind, name, cat, fa, ta, amt, args, fee)
       ON CONFLICT DO NOTHING`,
      [
        contractId,
        batch.map(r => r.timestamp),
        batch.map(r => r.blockNumber),
        batch.map(r => r.logIndex),
        batch.map(r => r.txHash),
        batch.map(r => r.kind),
        batch.map(r => r.eventName),
        batch.map(r => r.category),
        batch.map(r => r.from),
        batch.map(r => r.to),
        batch.map(r => r.amount),
        batch.map(r => (r.args ? JSON.stringify(r.args) : null)),
        batch.map(r => r.txFeeNative),
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}
