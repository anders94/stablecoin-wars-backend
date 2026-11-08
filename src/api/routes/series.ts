/**
 * Time series and range summaries across coins and networks.
 *
 * Day and coarser buckets come from the daily metrics rows; hour buckets come from the blocks
 * table. Supply is the running total of minted - burned since the contract's creation (the
 * metrics table's total_supply column is only rarely filled in). Amounts are returned as
 * numbers of whole tokens (amount / 10^decimals), so coins with different decimals can be
 * summed; fees are in the network's native currency.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../../db';
import { RESOLUTIONS } from '../../types';
import {
  BadRequest, ContractInfo, selectContracts, dateParam, stringListParam, pgTs, toUnits, nativeCurrency,
} from '../helpers';

const router = Router();

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const BUCKETS = ['auto', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
type Bucket = Exclude<typeof BUCKETS[number], 'auto'>;
const GROUP_BY = ['coin', 'network', 'contract', 'total'] as const;
type GroupBy = typeof GROUP_BY[number];
const MAX_HOUR_RANGE_DAYS = 31;

interface DailyRow {
  day: number; // UTC midnight, ms
  minted: bigint;
  burned: bigint;
  transfers: number;
  senders: number;
  receivers: number;
  volume: bigint;
  fees: bigint;
  supply: bigint; // running total through the end of this day
}

const dailyCache = new Map<string, { at: number; rows: DailyRow[] }>();
const DAILY_CACHE_MS = 60000;

function big(value: string | null): bigint {
  return value === null ? 0n : BigInt(value.split('.')[0]);
}

async function loadDaily(contracts: ContractInfo[]): Promise<Map<string, DailyRow[]>> {
  const result = new Map<string, DailyRow[]>();
  const missing = contracts.filter(c => {
    const cached = dailyCache.get(c.id);
    if (cached && Date.now() - cached.at < DAILY_CACHE_MS) {
      result.set(c.id, cached.rows);
      return false;
    }
    return true;
  });
  if (missing.length > 0) {
    const rows = await query<{
      contract_id: string; day: number; minted: string; burned: string; tx_count: number;
      unique_senders: number; unique_receivers: number; total_transferred: string; total_fees_native: string;
    }>(
      `SELECT contract_id, (extract(epoch FROM period_start) * 1000)::float8 AS day,
              minted::text, burned::text, tx_count, unique_senders, unique_receivers,
              total_transferred::text, total_fees_native::text
       FROM metrics
       WHERE resolution_seconds = $1 AND contract_id = ANY($2::uuid[])
       ORDER BY contract_id, period_start`,
      [RESOLUTIONS.DAY, missing.map(c => c.id)]
    );
    for (const c of missing) {
      result.set(c.id, []);
    }
    // Supply starts from what the contract created without an event
    const running = new Map<string, bigint>(missing.map(c => [c.id, big(c.initial_supply)]));
    for (const r of rows) {
      const minted = big(r.minted);
      const burned = big(r.burned);
      const supply = (running.get(r.contract_id) ?? 0n) + minted - burned;
      running.set(r.contract_id, supply);
      result.get(r.contract_id)!.push({
        day: Number(r.day), minted, burned, transfers: r.tx_count, senders: r.unique_senders,
        receivers: r.unique_receivers, volume: big(r.total_transferred), fees: big(r.total_fees_native), supply,
      });
    }
    for (const c of missing) {
      dailyCache.set(c.id, { at: Date.now(), rows: result.get(c.id)! });
    }
  }
  return result;
}

/**
 * Supply through the end of the last day before `t` (ms): the contract's initial supply from its
 * creation until its first day with activity, nothing before it existed.
 */
function supplyBefore(c: ContractInfo, rows: DailyRow[], t: number): bigint {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].day < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0) return rows[lo - 1].supply;
  const created = c.creation_date ? new Date(c.creation_date).getTime() : null;
  return created !== null && t > created ? big(c.initial_supply) : 0n;
}

function bucketStart(t: number, bucket: Bucket): number {
  const d = new Date(t);
  switch (bucket) {
    case 'hour': return Math.floor(t / HOUR_MS) * HOUR_MS;
    case 'day': return Math.floor(t / DAY_MS) * DAY_MS;
    case 'week': {
      const day = Math.floor(t / DAY_MS) * DAY_MS;
      const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
      return day - dow * DAY_MS;
    }
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'quarter': return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
    case 'year': return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}

function nextBucket(t: number, bucket: Bucket): number {
  const d = new Date(t);
  switch (bucket) {
    case 'hour': return t + HOUR_MS;
    case 'day': return t + DAY_MS;
    case 'week': return t + 7 * DAY_MS;
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case 'quarter': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1);
    case 'year': return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  }
}

export function autoBucket(from: Date, to: Date): Bucket {
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days <= 4) return 'hour';
  if (days <= 180) return 'day';
  if (days <= 3 * 365) return 'week';
  return 'month';
}

function groupKey(c: ContractInfo, groupBy: GroupBy): { key: string; label: string } {
  switch (groupBy) {
    case 'coin': return { key: c.ticker, label: c.coin_name };
    case 'network': return { key: c.network, label: c.network_display };
    case 'contract': return { key: `${c.ticker}:${c.network}`, label: `${c.ticker} on ${c.network_display}` };
    case 'total': return { key: 'total', label: 'All selected' };
  }
}

interface Point {
  t: string;
  minted: number;
  burned: number;
  net: number;
  volume: number;
  transfers: number;
  fees: number | null;
  supply: number;
  daily_senders: number | null;
  daily_receivers: number | null;
}

interface Accumulator {
  minted: number; burned: number; volume: number; transfers: number; fees: number;
  supply: number; senders: number; receivers: number; days: number;
}

const emptyAcc = (): Accumulator => ({ minted: 0, burned: 0, volume: 0, transfers: 0, fees: 0, supply: 0, senders: 0, receivers: 0, days: 0 });

function sharedFeeUnit(contracts: ContractInfo[]): { symbol: string; decimals: number } | null {
  const units = contracts.map(c => nativeCurrency(c.network, c.chain_type));
  return units.every(u => u.symbol === units[0].symbol) ? units[0] : null;
}

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(error => {
      if (error instanceof BadRequest) {
        res.status(400).json({ error: error.message });
      } else {
        next(error);
      }
    });
  };
}

/**
 * GET /api/series?from&to&bucket&coins&networks&group_by
 * One series per group, each with one point per bucket in [from, to).
 */
router.get('/series', wrap(async (req, res) => {
  const to = dateParam(req, 'to', new Date());
  const from = dateParam(req, 'from', new Date(to.getTime() - 90 * DAY_MS));
  if (from >= to) {
    throw new BadRequest('from must be before to');
  }
  const bucketParam = (stringListParam(req, 'bucket', BUCKETS)?.[0] ?? 'auto') as typeof BUCKETS[number];
  const bucket: Bucket = bucketParam === 'auto' ? autoBucket(from, to) : bucketParam;
  const groupBy = (stringListParam(req, 'group_by', GROUP_BY)?.[0] ?? 'coin') as GroupBy;
  const contracts = await selectContracts(req);

  if (bucket === 'hour' && to.getTime() - from.getTime() > MAX_HOUR_RANGE_DAYS * DAY_MS) {
    throw new BadRequest(`hour buckets are limited to ranges of ${MAX_HOUR_RANGE_DAYS} days`);
  }

  // Bucket start (ms) -> group key -> accumulated values
  const groups = new Map<string, { label: string; contracts: ContractInfo[]; buckets: Map<number, Accumulator> }>();
  for (const c of contracts) {
    const { key, label } = groupKey(c, groupBy);
    if (!groups.has(key)) groups.set(key, { label, contracts: [], buckets: new Map() });
    groups.get(key)!.contracts.push(c);
  }

  // Every bucket in the range, so gaps (days without activity) still get a point
  const fromMs = bucket === 'hour' ? from.getTime() : Math.floor(from.getTime() / DAY_MS) * DAY_MS;
  const toMs = to.getTime();
  const bucketStarts: number[] = [];
  for (let t = bucketStart(fromMs, bucket); t < toMs; t = nextBucket(t, bucket)) {
    bucketStarts.push(t);
  }

  const daily = await loadDaily(contracts);

  if (bucket === 'hour') {
    const rows = await query<{
      contract_id: string; h: number; minted: string; burned: string; tx: number; volume: string; fees: string;
    }>(
      `SELECT contract_id, (extract(epoch FROM date_trunc('hour', timestamp)) * 1000)::float8 AS h,
              sum(minted)::text AS minted, sum(burned)::text AS burned, sum(tx_count)::int AS tx,
              sum(total_transferred)::text AS volume, sum(total_fees_native)::text AS fees
       FROM blocks
       WHERE contract_id = ANY($1::uuid[]) AND timestamp >= $2 AND timestamp < $3
       GROUP BY 1, 2`,
      [contracts.map(c => c.id), pgTs(new Date(Math.floor(fromMs / DAY_MS) * DAY_MS)), pgTs(to)]
    );
    const byContract = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!byContract.has(r.contract_id)) byContract.set(r.contract_id, []);
      byContract.get(r.contract_id)!.push(r);
    }
    for (const c of contracts) {
      const group = groups.get(groupKey(c, groupBy).key)!;
      const fee = nativeCurrency(c.network, c.chain_type);
      const hours = (byContract.get(c.id) ?? []).sort((a, b) => a.h - b.h);
      // Supply at the start of the range's first day, then hour by hour (including hours of
      // that day before `from`, which only move the running supply)
      let supply = supplyBefore(c, daily.get(c.id) ?? [], Math.floor(fromMs / DAY_MS) * DAY_MS);
      const perHour = new Map(hours.map(h => [Number(h.h), h]));
      for (let t = Math.floor(fromMs / DAY_MS) * DAY_MS; t < toMs; t += HOUR_MS) {
        const h = perHour.get(t);
        if (h) supply += big(h.minted) - big(h.burned);
        if (t < bucketStarts[0]) continue;
        if (c.creation_date && t + HOUR_MS <= new Date(c.creation_date).getTime()) continue;
        const acc = group.buckets.get(t) ?? emptyAcc();
        if (h) {
          acc.minted += toUnits(big(h.minted), c.decimals)!;
          acc.burned += toUnits(big(h.burned), c.decimals)!;
          acc.volume += toUnits(big(h.volume), c.decimals)!;
          acc.transfers += h.tx;
          acc.fees += toUnits(big(h.fees), fee.decimals)!;
        }
        acc.supply += toUnits(supply, c.decimals)!;
        group.buckets.set(t, acc);
      }
    }
  } else {
    for (const c of contracts) {
      const group = groups.get(groupKey(c, groupBy).key)!;
      const fee = nativeCurrency(c.network, c.chain_type);
      const rows = daily.get(c.id) ?? [];
      if (rows.length === 0) continue;
      const firstDay = rows[0].day;
      const byDay = new Map(rows.map(r => [r.day, r]));
      for (const start of bucketStarts) {
        const end = Math.min(nextBucket(start, bucket), toMs);
        if (end <= firstDay) continue;
        const acc = group.buckets.get(start) ?? emptyAcc();
        for (let day = Math.max(start, fromMs, firstDay); day < end; day += DAY_MS) {
          const r = byDay.get(day);
          acc.days += 1;
          if (!r) continue;
          acc.minted += toUnits(r.minted, c.decimals)!;
          acc.burned += toUnits(r.burned, c.decimals)!;
          acc.volume += toUnits(r.volume, c.decimals)!;
          acc.transfers += r.transfers;
          acc.fees += toUnits(r.fees, fee.decimals)!;
          acc.senders += r.senders;
          acc.receivers += r.receivers;
        }
        acc.supply += toUnits(supplyBefore(c, rows, end), c.decimals)!;
        group.buckets.set(start, acc);
      }
    }
  }

  const series = [...groups.entries()].map(([key, g]) => {
    const feeUnit = sharedFeeUnit(g.contracts);
    const points: Point[] = bucketStarts
      .filter(t => g.buckets.has(t))
      .map(t => {
        const a = g.buckets.get(t)!;
        return {
          t: new Date(t).toISOString(),
          minted: a.minted,
          burned: a.burned,
          net: a.minted - a.burned,
          volume: a.volume,
          transfers: a.transfers,
          fees: feeUnit ? a.fees : null,
          supply: a.supply,
          // Average per day of each contract's daily unique addresses (not distinct across days)
          daily_senders: bucket === 'hour' || a.days === 0 ? null : a.senders / (a.days / g.contracts.length),
          daily_receivers: bucket === 'hour' || a.days === 0 ? null : a.receivers / (a.days / g.contracts.length),
        };
      });
    return { key, label: g.label, fee_unit: feeUnit?.symbol ?? null, contracts: g.contracts.map(c => c.id), points };
  });

  res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    bucket,
    group_by: groupBy,
    notes: bucket === 'hour'
      ? ['Hourly transfers include mints and burns; daily unique addresses are not available hourly.']
      : [],
    series,
  });
}));

interface Totals {
  supply_start: number;
  supply_end: number;
  minted: number;
  burned: number;
  net: number;
  volume: number;
  transfers: number;
  avg_daily_senders: number;
  avg_daily_receivers: number;
}

function summarize(contracts: ContractInfo[], daily: Map<string, DailyRow[]>, fromDay: number, toDay: number) {
  const totals: Totals = {
    supply_start: 0, supply_end: 0, minted: 0, burned: 0, net: 0, volume: 0, transfers: 0,
    avg_daily_senders: 0, avg_daily_receivers: 0,
  };
  const fees: Record<string, number> = {};
  const days = Math.max(1, (toDay - fromDay) / DAY_MS);
  for (const c of contracts) {
    const rows = daily.get(c.id) ?? [];
    totals.supply_start += toUnits(supplyBefore(c, rows, fromDay), c.decimals)!;
    totals.supply_end += toUnits(supplyBefore(c, rows, toDay), c.decimals)!;
    const fee = nativeCurrency(c.network, c.chain_type);
    for (const r of rows) {
      if (r.day < fromDay || r.day >= toDay) continue;
      totals.minted += toUnits(r.minted, c.decimals)!;
      totals.burned += toUnits(r.burned, c.decimals)!;
      totals.volume += toUnits(r.volume, c.decimals)!;
      totals.transfers += r.transfers;
      totals.avg_daily_senders += r.senders / days;
      totals.avg_daily_receivers += r.receivers / days;
      fees[fee.symbol] = (fees[fee.symbol] ?? 0) + toUnits(r.fees, fee.decimals)!;
    }
  }
  totals.net = totals.minted - totals.burned;
  return { ...totals, fees };
}

/**
 * GET /api/overview?from&to&coins&networks
 * Totals for the range (rounded out to whole UTC days) per coin, per network and overall, with
 * the same figures for the preceding period of equal length.
 */
router.get('/overview', wrap(async (req, res) => {
  const to = dateParam(req, 'to', new Date());
  const from = dateParam(req, 'from', new Date(to.getTime() - 30 * DAY_MS));
  if (from >= to) {
    throw new BadRequest('from must be before to');
  }
  const fromDay = Math.floor(from.getTime() / DAY_MS) * DAY_MS;
  const toDay = Math.ceil(to.getTime() / DAY_MS) * DAY_MS;
  const prevFromDay = fromDay - (toDay - fromDay);
  const contracts = await selectContracts(req);
  const daily = await loadDaily(contracts);

  const byKey = (keyOf: (c: ContractInfo) => string) => {
    const groups = new Map<string, ContractInfo[]>();
    for (const c of contracts) {
      const k = keyOf(c);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(c);
    }
    return Object.fromEntries([...groups.entries()].map(([k, cs]) => [k, {
      current: summarize(cs, daily, fromDay, toDay),
      previous: summarize(cs, daily, prevFromDay, fromDay),
    }]));
  };

  // Fees are complete from the latest point any selected contract has them from
  const feeFrom = contracts
    .map(c => (c.fee_low_block !== null ? (c.fee_from_time ? new Date(c.fee_from_time).getTime() : Date.now()) : null))
    .filter((t): t is number => t !== null)
    .reduce<number | null>((a, b) => (a === null || b > a ? b : a), null);

  res.json({
    from: new Date(fromDay).toISOString(),
    to: new Date(toDay).toISOString(),
    previous_from: new Date(prevFromDay).toISOString(),
    // Network fees before this time are incomplete (null: complete for the whole range)
    fees_complete_from: feeFrom !== null && feeFrom > fromDay ? new Date(feeFrom).toISOString() : null,
    total: {
      current: summarize(contracts, daily, fromDay, toDay),
      previous: summarize(contracts, daily, prevFromDay, fromDay),
    },
    by_coin: byKey(c => c.ticker),
    by_network: byKey(c => c.network),
    by_contract: byKey(c => `${c.ticker}:${c.network}`),
  });
}));

export default router;
