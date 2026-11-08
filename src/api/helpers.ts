import { Request } from 'express';
import { query } from '../db';

export class BadRequest extends Error {}

export interface ContractInfo {
  id: string;
  ticker: string;
  coin_name: string;
  company: string | null;
  decimals: number;
  network: string;
  network_display: string;
  chain_type: 'evm' | 'tron' | 'solana';
  address: string;
  creation_block: number | null;
  creation_date: Date | null;
  is_active: boolean;
  event_set: string;
  last_synced_block: number | null;
  last_synced_at: Date | null;
  sync_status: string | null;
  events_from_block: number | null;
  backfill_low_block: number | null;
  backfill_status: string | null;
  // Kept out of the public explorer while its history loads
  listed: boolean;
  // Supply created without an event (base units)
  initial_supply: string;
  // Lowest block from which transaction fees are recorded, and when that block was (null: from creation)
  fee_low_block: number | null;
  fee_from_time: Date | null;
  fee_backfill_status: string | null;
}

// Block explorers and native fee currencies by network name
const EXPLORERS: Record<string, { base: string; tx: string; address: string; block: string }> = {
  ethereum: { base: 'https://etherscan.io', tx: '/tx/{}', address: '/address/{}', block: '/block/{}' },
  polygon: { base: 'https://polygonscan.com', tx: '/tx/{}', address: '/address/{}', block: '/block/{}' },
  arbitrum: { base: 'https://arbiscan.io', tx: '/tx/{}', address: '/address/{}', block: '/block/{}' },
  optimism: { base: 'https://optimistic.etherscan.io', tx: '/tx/{}', address: '/address/{}', block: '/block/{}' },
  base: { base: 'https://basescan.org', tx: '/tx/{}', address: '/address/{}', block: '/block/{}' },
  bsc: { base: 'https://bscscan.com', tx: '/tx/{}', address: '/address/{}', block: '/block/{}' },
  avalanche: { base: 'https://snowtrace.io', tx: '/tx/{}', address: '/address/{}', block: '/block/{}' },
  tron: { base: 'https://tronscan.org', tx: '/#/transaction/{}', address: '/#/address/{}', block: '/#/block/{}' },
  solana: { base: 'https://solscan.io', tx: '/tx/{}', address: '/account/{}', block: '/block/{}' },
};

const NATIVE_CURRENCY: Record<string, { symbol: string; decimals: number }> = {
  ethereum: { symbol: 'ETH', decimals: 18 },
  arbitrum: { symbol: 'ETH', decimals: 18 },
  optimism: { symbol: 'ETH', decimals: 18 },
  base: { symbol: 'ETH', decimals: 18 },
  polygon: { symbol: 'POL', decimals: 18 },
  bsc: { symbol: 'BNB', decimals: 18 },
  avalanche: { symbol: 'AVAX', decimals: 18 },
  tron: { symbol: 'TRX', decimals: 6 },
  solana: { symbol: 'SOL', decimals: 9 },
};

export function explorerFor(network: string) {
  const e = EXPLORERS[network];
  return e ? { tx: e.base + e.tx, address: e.base + e.address, block: e.base + e.block } : null;
}

export function nativeCurrency(network: string, chainType: string) {
  return NATIVE_CURRENCY[network] ?? (chainType === 'evm' ? { symbol: 'ETH', decimals: 18 } : { symbol: '?', decimals: 0 });
}

let contractsCache: { at: number; contracts: ContractInfo[] } | null = null;
const CONTRACTS_CACHE_MS = 15000;

/** The contracts the public explorer shows (listed ones). */
export async function loadContracts(): Promise<ContractInfo[]> {
  return (await loadAllContracts()).filter(c => c.listed);
}

/** Every contract, including unlisted ones whose history is still loading (for the status page). */
export async function loadAllContracts(): Promise<ContractInfo[]> {
  if (contractsCache && Date.now() - contractsCache.at < CONTRACTS_CACHE_MS) {
    return contractsCache.contracts;
  }
  const rows = await query<ContractInfo>(
    `SELECT c.id, UPPER(s.ticker) AS ticker, s.name AS coin_name, co.name AS company, s.decimals,
            n.name AS network, n.display_name AS network_display, n.chain_type,
            c.contract_address AS address, c.creation_block::float8 AS creation_block, c.creation_date,
            c.is_active, c.event_set,
            ss.last_synced_block::float8 AS last_synced_block, ss.last_synced_at, ss.status AS sync_status,
            ss.events_from_block::float8 AS events_from_block,
            eb.low_block::float8 AS backfill_low_block, eb.status AS backfill_status,
            c.listed, c.initial_supply::text AS initial_supply,
            CASE WHEN fb.status = 'complete' THEN NULL ELSE fb.low_block::float8 END AS fee_low_block,
            CASE WHEN fb.status = 'complete' THEN NULL ELSE
              (SELECT b.timestamp FROM blocks b
               WHERE b.contract_id = c.id AND b.block_number >= fb.low_block AND b.timestamp IS NOT NULL
               ORDER BY b.block_number LIMIT 1) END AS fee_from_time,
            fb.status AS fee_backfill_status
     FROM contracts c
     JOIN stablecoins s ON c.stablecoin_id = s.id
     LEFT JOIN companies co ON s.company_id = co.id
     JOIN networks n ON c.network_id = n.id
     LEFT JOIN sync_state ss ON ss.contract_id = c.id
     LEFT JOIN event_backfill_state eb ON eb.contract_id = c.id
     LEFT JOIN fee_backfill_state fb ON fb.contract_id = c.id
     ORDER BY s.ticker, n.name`
  );
  contractsCache = { at: Date.now(), contracts: rows };
  return rows;
}

/** Lowest block from which every event of the contract is stored, or null if none are. */
export function eventCoverageFrom(c: ContractInfo): number | null {
  if (c.events_from_block === null) {
    return null;
  }
  if (c.backfill_low_block !== null) {
    return Math.min(c.backfill_low_block, c.events_from_block);
  }
  return c.events_from_block;
}

function listParam(req: Request, name: string): string[] | null {
  const raw = req.query[name];
  if (raw === undefined || raw === '') {
    return null;
  }
  const values = (Array.isArray(raw) ? raw.join(',') : String(raw))
    .split(',').map(v => v.trim()).filter(Boolean);
  return values.length > 0 ? values : null;
}

export function stringListParam(req: Request, name: string, allowed?: readonly string[]): string[] | null {
  const values = listParam(req, name);
  if (values && allowed) {
    const bad = values.find(v => !allowed.includes(v));
    if (bad) {
      throw new BadRequest(`Invalid ${name} value "${bad}". Allowed: ${allowed.join(', ')}`);
    }
  }
  return values;
}

/** Contracts selected by the coins (tickers) and networks query parameters. */
export async function selectContracts(req: Request): Promise<ContractInfo[]> {
  const coins = listParam(req, 'coins')?.map(c => c.toUpperCase()) ?? null;
  const networks = listParam(req, 'networks')?.map(n => n.toLowerCase()) ?? null;
  const all = await loadContracts();
  return all.filter(c =>
    (!coins || coins.includes(c.ticker)) &&
    (!networks || networks.includes(c.network))
  );
}

export function dateParam(req: Request, name: string, fallback?: Date): Date {
  const raw = req.query[name];
  if (raw === undefined || raw === '') {
    if (fallback) {
      return fallback;
    }
    throw new BadRequest(`${name} is required (ISO 8601 date or time)`);
  }
  const d = new Date(String(raw));
  if (isNaN(d.getTime())) {
    throw new BadRequest(`Invalid ${name}: use ISO 8601`);
  }
  return d;
}

export function optionalDateParam(req: Request, name: string): Date | null {
  return req.query[name] === undefined || req.query[name] === '' ? null : dateParam(req, name);
}

export function intParam(req: Request, name: string, fallback: number, min: number, max: number): number {
  const raw = req.query[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/**
 * A Date as a timestamp-without-time-zone literal in UTC. Timestamps are stored as UTC wall
 * clock time, so this keeps queries independent of the server's time zone.
 */
export function pgTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/** A timestamp-without-time-zone value read back from Postgres, as a UTC ISO string. */
export function isoTs(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    // node-pg parses timestamp-without-time-zone as local time; reinterpret it as UTC
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString();
  }
  return new Date(value.replace(' ', 'T') + 'Z').toISOString();
}

/** A timestamp-without-time-zone value read from Postgres, as a query parameter again. */
export function dbTs(value: Date): string {
  return pgTs(new Date(isoTs(value)!));
}

/** Token amount in base units (string) as a number of whole tokens. */
export function toUnits(base: string | bigint | null, decimals: number): number | null {
  if (base === null) {
    return null;
  }
  const s = typeof base === 'bigint' ? base.toString() : base.split('.')[0];
  const negative = s.startsWith('-');
  const digits = negative ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  const n = Number(`${whole}.${frac || '0'}`);
  return negative ? -n : n;
}

/** A decimal number of whole tokens (e.g. "1000000.5") in base units. */
export function toBaseUnits(units: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(units)) {
    throw new BadRequest(`Invalid amount "${units}"`);
  }
  const [whole, frac = ''] = units.split('.');
  const scaled = BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
  return scaled.toString();
}

export function normalizeAddressParam(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;
}

export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, length: number): unknown[] | null {
  if (!cursor) {
    return null;
  }
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(values) && values.length === length) {
      return values;
    }
  } catch {
    // fall through
  }
  throw new BadRequest('Invalid cursor');
}
