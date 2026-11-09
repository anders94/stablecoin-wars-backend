/**
 * Keep frozen_addresses: the addresses on each contract's blacklist now, with their balance.
 *
 * The list comes from the freeze events already indexed (the event set marks which events add an
 * address to the blacklist and which remove it; the latest per address wins). Balances come from
 * balanceOf at the contract's last synced block, since summing an address's whole event history
 * is far too slow for some frozen addresses. Each contract is rewritten in one transaction.
 *
 * The indexer worker refreshes a contract when a new freeze event arrives (checked every
 * 10 minutes) and at least hourly. Run by hand for the first fill:
 *   ts-node src/indexer/frozen.ts [contract-id...]
 */
import dotenv from 'dotenv';
dotenv.config();

import { query, queryOne, transaction, closePool } from '../db';
import { createAdapter } from './adapters';
import { getEventSet, freezeListEventNames, destroyedFundsEventNames } from './eventSets';
import { StatusLineReporter } from './statusLineReporter';

export interface FreezeContract {
  id: string;
  ticker: string;
  network: string;
  chain_type: 'evm' | 'tron' | 'solana';
  contract_address: string;
  rpc_endpoint: string;
  event_set: string | null;
  last_synced_block: string | null;
}

const FULL_REFRESH_MS = 60 * 60 * 1000;
const BALANCE_PARALLEL = 8;

export async function freezeContracts(ids?: string[]): Promise<FreezeContract[]> {
  const all = await query<FreezeContract>(
    `SELECT c.id, s.ticker, n.name AS network, n.chain_type, c.contract_address, re.url AS rpc_endpoint,
            c.event_set, ss.last_synced_block
     FROM contracts c
     JOIN stablecoins s ON s.id = c.stablecoin_id
     JOIN networks n ON n.id = c.network_id
     JOIN rpc_endpoints re ON re.id = c.rpc_endpoint_id
     LEFT JOIN sync_state ss ON ss.contract_id = c.id
     WHERE c.is_active = true AND ($1::uuid[] IS NULL OR c.id = ANY($1::uuid[]))`,
    [ids && ids.length > 0 ? ids : null]
  );
  return all.filter(c => freezeListEventNames(getEventSet(c.event_set)).add.length > 0);
}

export interface FrozenRow {
  address: string;
  timestamp: Date;
  block_number: string;
  tx_hash: string;
  times: string;
  balance: string | null;
  destroyed: string;
}

/** A contract's blacklisted addresses now, with their balances at its last synced block. */
export async function loadFrozenAddresses(c: FreezeContract): Promise<{ rows: FrozenRow[]; balanceBlock: number | null }> {
  const set = getEventSet(c.event_set);
  const names = freezeListEventNames(set);
  const destroyedNames = destroyedFundsEventNames(set);

  const frozen = await query<{ address: string; timestamp: Date; block_number: string; tx_hash: string; times: string }>(
    `WITH f AS (
       SELECT to_address AS address, event_name, timestamp, block_number, tx_hash,
              row_number() OVER (PARTITION BY to_address ORDER BY block_number DESC, log_index DESC) AS rn,
              count(*) FILTER (WHERE event_name = ANY($2::text[])) OVER (PARTITION BY to_address) AS times
       FROM events
       WHERE contract_id = $1 AND kind = 'admin' AND to_address IS NOT NULL
         AND event_name = ANY($2::text[] || $3::text[])
     )
     SELECT address, timestamp, block_number, tx_hash, times FROM f
     WHERE rn = 1 AND event_name = ANY($2::text[])`,
    [c.id, names.add, names.remove]
  );

  const destroyed = new Map<string, string>();
  if (destroyedNames.length > 0) {
    const rows = await query<{ address: string; amount: string }>(
      `SELECT from_address AS address, sum(amount)::text AS amount FROM events
       WHERE contract_id = $1 AND kind = 'burn' AND event_name = ANY($2::text[]) AND from_address IS NOT NULL
       GROUP BY 1`,
      [c.id, destroyedNames]
    );
    for (const r of rows) destroyed.set(r.address, r.amount);
  }

  // Balances at the block the indexed events run to, so list and balances agree
  let balances: (string | null)[] = frozen.map(() => null);
  let balanceBlock: number | null = null;
  if (c.last_synced_block && frozen.length > 0) {
    const adapter = await createAdapter(c.chain_type, c.rpc_endpoint);
    try {
      if (adapter.getBalancesAt) {
        balanceBlock = Number(c.last_synced_block);
        balances = await adapter.getBalancesAt(c.contract_address, frozen.map(f => f.address), balanceBlock, BALANCE_PARALLEL);
      }
    } finally {
      await adapter.disconnect();
    }
  }

  return {
    rows: frozen.map((f, i) => ({ ...f, balance: balances[i], destroyed: destroyed.get(f.address) ?? '0' })),
    balanceBlock,
  };
}

/** Rebuild one contract's frozen addresses. Returns the number of frozen addresses and their total balance. */
export async function refreshFrozenAddresses(c: FreezeContract): Promise<{ addresses: number; balance: bigint }> {
  const { rows: frozen, balanceBlock } = await loadFrozenAddresses(c);
  await transaction(async (client) => {
    await client.query(
      `DELETE FROM frozen_addresses WHERE contract_id = $1 AND NOT (address = ANY($2::text[]))`,
      [c.id, frozen.map(f => f.address)]
    );
    if (frozen.length === 0) return;
    await client.query(
      `INSERT INTO frozen_addresses (contract_id, address, frozen_at, frozen_block, frozen_tx, times_frozen,
                                     balance, destroyed, balance_block, updated_at)
       SELECT $1, u.address, u.frozen_at, u.frozen_block, u.frozen_tx, u.times, u.balance::numeric,
              u.destroyed::numeric, $2, NOW()
       FROM unnest($3::text[], $4::timestamp[], $5::bigint[], $6::text[], $7::int[], $8::text[], $9::text[])
         AS u(address, frozen_at, frozen_block, frozen_tx, times, balance, destroyed)
       ON CONFLICT (contract_id, address) DO UPDATE SET
         frozen_at = EXCLUDED.frozen_at, frozen_block = EXCLUDED.frozen_block, frozen_tx = EXCLUDED.frozen_tx,
         times_frozen = EXCLUDED.times_frozen, balance = EXCLUDED.balance, destroyed = EXCLUDED.destroyed,
         balance_block = EXCLUDED.balance_block, updated_at = NOW()`,
      [
        c.id, balanceBlock,
        frozen.map(f => f.address), frozen.map(f => f.timestamp), frozen.map(f => f.block_number),
        frozen.map(f => f.tx_hash), frozen.map(f => Number(f.times)), frozen.map(f => f.balance),
        frozen.map(f => f.destroyed),
      ]
    );
  });

  const balance = frozen.reduce((sum, f) => sum + BigInt(f.balance ?? 0), 0n);
  return { addresses: frozen.length, balance };
}

// Per contract: when it was last refreshed, and the newest freeze-list event seen then
const lastRefresh = new Map<string, { at: number; latestEvent: number }>();
let refreshing = false;

/**
 * Refresh every contract with a blacklist whose freeze events changed since its last refresh, or
 * whose last refresh is over an hour old (balances move, and DestroyedBlackFunds can arrive
 * alone). Called periodically by the worker; overlapping calls are skipped.
 */
export async function refreshFrozenIfDue(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    for (const c of await freezeContracts()) {
      const names = freezeListEventNames(getEventSet(c.event_set));
      const latest = await queryOne<{ t: Date | null }>(
        `SELECT max(timestamp) AS t FROM events
         WHERE contract_id = $1 AND kind = 'admin' AND event_name = ANY($2::text[])`,
        [c.id, [...names.add, ...names.remove]]
      );
      const latestEvent = latest?.t ? latest.t.getTime() : 0;
      const prev = lastRefresh.get(c.id);
      if (prev && prev.latestEvent === latestEvent && Date.now() - prev.at < FULL_REFRESH_MS) continue;
      try {
        const started = Date.now();
        const { addresses } = await refreshFrozenAddresses(c);
        lastRefresh.set(c.id, { at: Date.now(), latestEvent });
        StatusLineReporter.getInstance().log(`Frozen addresses: ${c.ticker} on ${c.network}: ${addresses} (${Math.round((Date.now() - started) / 1000)}s)`);
      } catch (error) {
        console.error(`Frozen address refresh failed for ${c.ticker} on ${c.network}:`, error);
      }
    }
  } finally {
    refreshing = false;
  }
}

async function main() {
  const contracts = await freezeContracts(process.argv.slice(2));
  if (contracts.length === 0) console.log('No matching contracts with a blacklist');
  for (const c of contracts) {
    const started = Date.now();
    const { addresses, balance } = await refreshFrozenAddresses(c);
    console.log(`${c.ticker} on ${c.network}: ${addresses} frozen addresses holding ${balance.toString()} base units (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
