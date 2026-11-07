/**
 * Individual events: lists, details, transactions, blocks, addresses and top flows.
 *
 * Event amounts are returned both exactly (amount, base units as a string) and as a number of
 * whole tokens (amount_units). Event ids are "<contract id>:<block>:<log index>".
 */
import { Router, Request, Response, NextFunction } from 'express';
import { PoolClient } from 'pg';
import { query, queryOne, getClient } from '../../db';
import {
  BadRequest, ContractInfo, loadContracts, selectContracts, optionalDateParam, dateParam, intParam,
  stringListParam, pgTs, dbTs, isoTs, toUnits, toBaseUnits, normalizeAddressParam, encodeCursor, decodeCursor,
  explorerFor, nativeCurrency, eventCoverageFrom,
} from '../helpers';

const router = Router();

const KINDS = ['transfer', 'mint', 'burn', 'admin'] as const;
const CATEGORIES = ['freeze', 'minter', 'role', 'pause', 'upgrade', 'issuance', 'config'] as const;
const SORTS = ['time_desc', 'time_asc', 'amount_desc'] as const;
type Sort = typeof SORTS[number];
const DAY_MS = 86400000;
const MAX_FLOW_RANGE_DAYS = 31;

interface EventDbRow {
  contract_id: string;
  timestamp: Date;
  block_number: string;
  log_index: number;
  tx_hash: string;
  kind: string;
  event_name: string;
  category: string | null;
  from_address: string | null;
  to_address: string | null;
  amount: string | null;
  args: Record<string, string> | null;
  tx_fee_native: string | null;
}

// Raw columns: node-pg already returns BIGINT and NUMERIC as strings, and the merged event
// list must sort on the real types
const EVENT_COLUMNS = `contract_id, timestamp, block_number, log_index, tx_hash, kind, event_name, category,
  from_address, to_address, amount, args, tx_fee_native`;

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(error => {
      if (error instanceof BadRequest) {
        res.status(400).json({ error: error.message });
      } else if ((error as { code?: string }).code === '57014') {
        res.status(503).json({ error: 'Query took too long; narrow the time range or filters' });
      } else {
        next(error);
      }
    });
  };
}

function formatEvent(row: EventDbRow, contracts: Map<string, ContractInfo>) {
  const c = contracts.get(row.contract_id)!;
  const fee = nativeCurrency(c.network, c.chain_type);
  return {
    id: `${row.contract_id}:${row.block_number}:${row.log_index}`,
    contract_id: row.contract_id,
    ticker: c.ticker,
    network: c.network,
    decimals: c.decimals,
    timestamp: isoTs(row.timestamp),
    block_number: Number(row.block_number),
    log_index: row.log_index,
    tx_hash: row.tx_hash,
    kind: row.kind,
    event_name: row.event_name,
    category: row.category,
    from: row.from_address,
    to: row.to_address,
    amount: row.amount,
    amount_units: toUnits(row.amount, c.decimals),
    args: row.args,
    tx_fee: row.tx_fee_native === null ? null : toUnits(row.tx_fee_native, fee.decimals),
    fee_unit: fee.symbol,
  };
}

async function contractMap(): Promise<Map<string, ContractInfo>> {
  return new Map((await loadContracts()).map(c => [c.id, c]));
}

/** Run a query with its own statement timeout. */
async function timedQuery<T>(sql: string, params: unknown[], timeoutMs: number): Promise<T[]> {
  const client: PoolClient = await getClient();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * GET /api/events
 *   from, to             time range (optional)
 *   coins, networks      contract selection
 *   kinds                transfer,mint,burn,admin
 *   categories           admin categories to include (freeze,minter,role,pause,upgrade,issuance,config)
 *   exclude_categories   admin categories to leave out (e.g. issuance)
 *   names                event names (e.g. Blacklisted,Upgraded)
 *   address              events from or to this address
 *   min_amount, max_amount  in whole tokens
 *   block                a single block number
 *   sort                 time_desc (default) | time_asc | amount_desc
 *   limit, cursor        page size (max 1000) and the next_cursor of the previous page
 */
router.get('/events', wrap(async (req, res) => {
  const contracts = await selectContracts(req);
  const from = optionalDateParam(req, 'from');
  const to = optionalDateParam(req, 'to');
  const kinds = stringListParam(req, 'kinds', KINDS);
  const categories = stringListParam(req, 'categories', CATEGORIES);
  const excludeCategories = stringListParam(req, 'exclude_categories', CATEGORIES);
  const names = stringListParam(req, 'names');
  const address = req.query.address ? normalizeAddressParam(String(req.query.address)) : null;
  const block = req.query.block !== undefined ? intParam(req, 'block', 0, 0, Number.MAX_SAFE_INTEGER) : null;
  const sort = (stringListParam(req, 'sort', SORTS)?.[0] ?? 'time_desc') as Sort;
  const limit = intParam(req, 'limit', 100, 1, 1000);
  const minAmount = req.query.min_amount ? String(req.query.min_amount) : null;
  const maxAmount = req.query.max_amount ? String(req.query.max_amount) : null;
  const cursor = decodeCursor(req.query.cursor as string | undefined, sort === 'amount_desc' ? 5 : 4);

  const params: unknown[] = [];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  // Conditions shared by every per-contract subquery
  const common: string[] = [];
  if (from) common.push(`timestamp >= ${p(pgTs(from))}`);
  if (to) common.push(`timestamp < ${p(pgTs(to))}`);
  if (kinds) common.push(`kind = ANY(${p(kinds)}::text[])`);
  if (categories) common.push(`category = ANY(${p(categories)}::text[])`);
  if (excludeCategories) common.push(`(category IS NULL OR NOT category = ANY(${p(excludeCategories)}::text[]))`);
  if (names) common.push(`event_name = ANY(${p(names)}::text[])`);
  if (block !== null) common.push(`block_number = ${p(block)}`);
  if (sort === 'amount_desc') common.push('amount IS NOT NULL');

  // Keyset pagination: rows strictly after the cursor in the sort order
  let order: string;
  if (sort === 'amount_desc') {
    order = 'amount DESC, timestamp DESC, block_number DESC, log_index DESC, contract_id DESC';
    if (cursor) {
      const [amt, ts, bn, li, cid] = cursor as [string, string, number, number, string];
      common.push(`(amount, timestamp, block_number, log_index, contract_id) < (${p(amt)}::numeric, ${p(pgTs(new Date(ts)))}::timestamp, ${p(bn)}::bigint, ${p(li)}::int, ${p(cid)}::uuid)`);
    }
  } else {
    const dir = sort === 'time_asc' ? 'ASC' : 'DESC';
    const cmp = sort === 'time_asc' ? '>' : '<';
    order = `timestamp ${dir}, block_number ${dir}, log_index ${dir}, contract_id ${dir}`;
    if (cursor) {
      const [ts, bn, li, cid] = cursor as [string, number, number, string];
      common.push(`(timestamp, block_number, log_index, contract_id) ${cmp} (${p(pgTs(new Date(ts)))}::timestamp, ${p(bn)}::bigint, ${p(li)}::int, ${p(cid)}::uuid)`);
    }
  }

  // One subquery per contract (and per address side) so each can walk its own index in sort
  // order; the outer query merges them
  const subqueries: string[] = [];
  const limitParam = p(limit + 1);
  for (const c of contracts) {
    const own = [`contract_id = ${p(c.id)}::uuid`, ...common];
    if (minAmount) own.push(`amount >= ${p(toBaseUnits(minAmount, c.decimals))}::numeric`);
    if (maxAmount) own.push(`amount <= ${p(toBaseUnits(maxAmount, c.decimals))}::numeric`);
    const sides = address ? [`from_address = ${p(address)}`, `to_address = ${p(address)}`] : [null];
    for (const side of sides) {
      const where = side ? [...own, side] : own;
      subqueries.push(`(SELECT ${EVENT_COLUMNS} FROM events WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limitParam})`);
    }
  }

  let rows: EventDbRow[] = [];
  if (subqueries.length > 0) {
    // DISTINCT: a transfer from an address to itself appears on both sides
    rows = await timedQuery<EventDbRow>(
      `SELECT DISTINCT ON (${order.replace(/ (ASC|DESC)/g, '')}) * FROM (${subqueries.join(' UNION ALL ')}) u
       ORDER BY ${order} LIMIT ${limitParam}`,
      params,
      30000
    );
  }

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last) {
    const ts = isoTs(last.timestamp);
    nextCursor = sort === 'amount_desc'
      ? encodeCursor([last.amount, ts, Number(last.block_number), last.log_index, last.contract_id])
      : encodeCursor([ts, Number(last.block_number), last.log_index, last.contract_id]);
  }

  const map = await contractMap();
  res.json({
    events: page.map(r => formatEvent(r, map)),
    next_cursor: nextCursor,
    coverage: contracts.map(c => ({ contract_id: c.id, ticker: c.ticker, network: c.network, events_from_block: eventCoverageFrom(c) })),
  });
}));

/**
 * GET /api/events/summary?from&to&coins&networks
 * Counts and amounts of non-transfer events (mints, burns, administrative events) by contract,
 * kind, category and event name. Transfer counts are in /api/series and /api/overview.
 */
router.get('/events/summary', wrap(async (req, res) => {
  const contracts = await selectContracts(req);
  const from = optionalDateParam(req, 'from');
  const to = optionalDateParam(req, 'to');
  const params: unknown[] = [contracts.map(c => c.id)];
  const conds = [`contract_id = ANY($1::uuid[])`, `kind <> 'transfer'`];
  if (from) { params.push(pgTs(from)); conds.push(`timestamp >= $${params.length}`); }
  if (to) { params.push(pgTs(to)); conds.push(`timestamp < $${params.length}`); }
  const rows = await timedQuery<{ contract_id: string; kind: string; category: string | null; event_name: string; count: string; amount: string | null; first: Date; last: Date }>(
    `SELECT contract_id, kind, category, event_name, count(*)::text AS count, sum(amount)::text AS amount,
            min(timestamp) AS first, max(timestamp) AS last
     FROM events WHERE ${conds.join(' AND ')}
     GROUP BY 1, 2, 3, 4 ORDER BY count(*) DESC`,
    params,
    30000
  );
  const map = await contractMap();
  res.json({
    groups: rows.map(r => {
      const c = map.get(r.contract_id)!;
      return {
        contract_id: r.contract_id, ticker: c.ticker, network: c.network,
        kind: r.kind, category: r.category, event_name: r.event_name,
        count: Number(r.count), amount_units: toUnits(r.amount, c.decimals),
        first: isoTs(r.first), last: isoTs(r.last),
      };
    }),
  });
}));

async function blockTimestamp(contractId: string, blockNumber: number): Promise<Date | null> {
  const row = await queryOne<{ timestamp: Date | null }>(
    'SELECT timestamp FROM blocks WHERE contract_id = $1 AND block_number = $2',
    [contractId, blockNumber]
  );
  return row?.timestamp ?? null;
}

/**
 * GET /api/events/:contractId/:blockNumber/:logIndex
 * One event, the other events of its transaction, and its block's aggregates.
 */
router.get('/events/:contractId/:blockNumber/:logIndex', wrap(async (req, res) => {
  const contractId = String(req.params.contractId);
  const blockNumber = Number(req.params.blockNumber);
  const logIndex = Number(req.params.logIndex);
  if (!/^[0-9a-f-]{36}$/i.test(contractId) || !Number.isInteger(blockNumber) || !Number.isInteger(logIndex)) {
    throw new BadRequest('Invalid event id');
  }
  const map = await contractMap();
  if (!map.has(contractId)) {
    res.status(404).json({ error: 'Unknown contract' });
    return;
  }
  // The block's timestamp narrows the search to one partition
  const ts = await blockTimestamp(contractId, blockNumber);
  const tsCond = ts ? `AND timestamp = $4` : '';
  const params: unknown[] = [contractId, blockNumber, logIndex];
  if (ts) params.push(dbTs(ts));
  const row = await queryOne<EventDbRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE contract_id = $1 AND block_number = $2 AND log_index = $3 ${tsCond}`,
    params
  );
  if (!row) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  const event = formatEvent(row, map);
  const tx = await txEvents(row.tx_hash, row.timestamp);
  res.json({
    event,
    transaction: { tx_hash: row.tx_hash, events: tx.map(r => formatEvent(r, map)) },
    block: await blockAggregates(map.get(contractId)!, blockNumber),
    explorer: explorerFor(event.network),
  });
}));

async function txEvents(txHash: string, timestamp?: Date): Promise<EventDbRow[]> {
  const params: unknown[] = [txHash];
  let tsCond = '';
  if (timestamp) {
    params.push(dbTs(timestamp));
    tsCond = 'AND timestamp = $2';
  }
  return query<EventDbRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE tx_hash = $1 ${tsCond} ORDER BY block_number, log_index LIMIT 5000`,
    params
  );
}

async function blockAggregates(c: ContractInfo, blockNumber: number) {
  const b = await queryOne<{ timestamp: Date | null; minted: string; burned: string; tx_count: number; total_transferred: string; total_fees_native: string }>(
    `SELECT timestamp, minted::text, burned::text, tx_count, total_transferred::text, total_fees_native::text
     FROM blocks WHERE contract_id = $1 AND block_number = $2`,
    [c.id, blockNumber]
  );
  if (!b) {
    return null;
  }
  const fee = nativeCurrency(c.network, c.chain_type);
  return {
    contract_id: c.id, ticker: c.ticker, network: c.network, block_number: blockNumber,
    timestamp: isoTs(b.timestamp),
    minted: toUnits(b.minted, c.decimals), burned: toUnits(b.burned, c.decimals),
    events: b.tx_count, volume: toUnits(b.total_transferred, c.decimals),
    fees: toUnits(b.total_fees_native, fee.decimals), fee_unit: fee.symbol,
  };
}

/** GET /api/tx/:hash — every indexed event of a transaction. */
router.get('/tx/:hash', wrap(async (req, res) => {
  const hash = String(req.params.hash);
  const rows = await txEvents(/^0x[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : hash);
  if (rows.length === 0) {
    res.status(404).json({ error: 'No indexed events for this transaction' });
    return;
  }
  const map = await contractMap();
  const events = rows.map(r => formatEvent(r, map));
  const first = events[0];
  res.json({
    tx_hash: first.tx_hash,
    network: first.network,
    block_number: first.block_number,
    timestamp: first.timestamp,
    tx_fee: first.tx_fee,
    fee_unit: first.fee_unit,
    events,
    explorer: explorerFor(first.network),
  });
}));

/** GET /api/blocks/:network/:number — per-contract aggregates and events of one block. */
router.get('/blocks/:network/:number', wrap(async (req, res) => {
  const network = String(req.params.network).toLowerCase();
  const blockNumber = Number(req.params.number);
  if (!Number.isInteger(blockNumber) || blockNumber < 0) {
    throw new BadRequest('Invalid block number');
  }
  const contracts = (await loadContracts()).filter(c => c.network === network);
  if (contracts.length === 0) {
    res.status(404).json({ error: 'Unknown network' });
    return;
  }
  const map = await contractMap();
  const perContract = [];
  for (const c of contracts) {
    const aggregates = await blockAggregates(c, blockNumber);
    const ts = await blockTimestamp(c.id, blockNumber);
    const params: unknown[] = [c.id, blockNumber];
    if (ts) params.push(dbTs(ts));
    const rows = await query<EventDbRow>(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE contract_id = $1 AND block_number = $2 ${ts ? 'AND timestamp = $3' : ''}
       ORDER BY log_index LIMIT 2000`,
      params
    );
    perContract.push({ aggregates, events: rows.map(r => formatEvent(r, map)) });
  }
  const timestamp = perContract.map(p => p.aggregates?.timestamp ?? p.events[0]?.timestamp).find(Boolean) ?? null;
  res.json({ network, block_number: blockNumber, timestamp, contracts: perContract, explorer: explorerFor(network) });
}));

/**
 * GET /api/addresses/:address?from&to&coins&networks
 * Totals sent and received per contract, a daily in/out series, administrative events naming
 * the address, and its largest counterparties.
 */
router.get('/addresses/:address', wrap(async (req, res) => {
  const address = normalizeAddressParam(String(req.params.address));
  const contracts = await selectContracts(req);
  const from = optionalDateParam(req, 'from');
  const to = optionalDateParam(req, 'to');
  const ids = contracts.map(c => c.id);
  const params: unknown[] = [address, ids];
  const timeConds: string[] = [];
  if (from) { params.push(pgTs(from)); timeConds.push(`timestamp >= $${params.length}`); }
  if (to) { params.push(pgTs(to)); timeConds.push(`timestamp < $${params.length}`); }
  const time = timeConds.length ? 'AND ' + timeConds.join(' AND ') : '';

  // Each side walks its own address index
  const sides = `
    SELECT 'out' AS dir, contract_id, timestamp, kind, amount, to_address AS counterparty FROM events
      WHERE from_address = $1 AND contract_id = ANY($2::uuid[]) ${time}
    UNION ALL
    SELECT 'in' AS dir, contract_id, timestamp, kind, amount, from_address AS counterparty FROM events
      WHERE to_address = $1 AND contract_id = ANY($2::uuid[]) ${time}`;

  const daily = await timedQuery<{ dir: string; contract_id: string; day: Date; kind: string; n: string; amount: string | null; first: Date; last: Date }>(
    `SELECT dir, contract_id, date_trunc('day', timestamp) AS day, kind, count(*)::text AS n, sum(amount)::text AS amount,
            min(timestamp) AS first, max(timestamp) AS last
     FROM (${sides}) s GROUP BY 1, 2, 3, 4 ORDER BY 3`,
    params,
    45000
  );
  const counterparties = await timedQuery<{ dir: string; contract_id: string; counterparty: string | null; n: string; amount: string | null }>(
    `SELECT dir, contract_id, counterparty, count(*)::text AS n, sum(amount)::text AS amount
     FROM (${sides}) s WHERE kind <> 'admin' GROUP BY 1, 2, 3 ORDER BY sum(amount) DESC NULLS LAST LIMIT 40`,
    params,
    45000
  );

  const map = await contractMap();
  const totals = new Map<string, { contract_id: string; ticker: string; network: string; sent: number; sent_count: number; received: number; received_count: number; first_seen: string | null; last_seen: string | null; admin_events: number }>();
  const series = new Map<string, { t: string; in: number; out: number }>();
  for (const r of daily) {
    const c = map.get(r.contract_id)!;
    const t = totals.get(c.id) ?? { contract_id: c.id, ticker: c.ticker, network: c.network, sent: 0, sent_count: 0, received: 0, received_count: 0, first_seen: null, last_seen: null, admin_events: 0 };
    const first = isoTs(r.first);
    const last = isoTs(r.last);
    if (!t.first_seen || (first && first < t.first_seen)) t.first_seen = first;
    if (!t.last_seen || (last && last > t.last_seen)) t.last_seen = last;
    if (r.kind === 'admin') {
      t.admin_events += Number(r.n);
    } else {
      const amount = toUnits(r.amount, c.decimals) ?? 0;
      if (r.dir === 'out') { t.sent += amount; t.sent_count += Number(r.n); } else { t.received += amount; t.received_count += Number(r.n); }
      const day = isoTs(r.day)!;
      const point = series.get(day) ?? { t: day, in: 0, out: 0 };
      if (r.dir === 'out') point.out += amount; else point.in += amount;
      series.set(day, point);
    }
    totals.set(c.id, t);
  }

  // Administrative events naming the address (e.g. Blacklisted), which are few
  const adminParams: unknown[] = [address, ids];
  const admin = await query<EventDbRow>(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE kind = 'admin' AND category <> 'issuance' AND contract_id = ANY($2::uuid[])
       AND (from_address = $1 OR to_address = $1)
     ORDER BY timestamp DESC LIMIT 200`,
    adminParams
  );

  res.json({
    address,
    totals: [...totals.values()],
    daily: [...series.values()].sort((a, b) => a.t.localeCompare(b.t)),
    admin_events: admin.map(r => formatEvent(r, map)),
    counterparties: counterparties.map(r => {
      const c = map.get(r.contract_id)!;
      return { direction: r.dir, ticker: c.ticker, network: c.network, address: r.counterparty, count: Number(r.n), amount_units: toUnits(r.amount, c.decimals) };
    }),
    coverage: contracts.map(c => ({ contract_id: c.id, events_from_block: eventCoverageFrom(c) })),
  });
}));

/**
 * GET /api/flows/top?from&to&coins&networks&by=sender|receiver|pair&kinds&limit
 * Addresses (or address pairs) moving the most tokens in the range, in whole tokens summed
 * across the selected coins. Ranges are limited to 31 days.
 */
router.get('/flows/top', wrap(async (req, res) => {
  const to = dateParam(req, 'to', new Date());
  const from = dateParam(req, 'from', new Date(to.getTime() - DAY_MS));
  if (to.getTime() - from.getTime() > MAX_FLOW_RANGE_DAYS * DAY_MS || from >= to) {
    throw new BadRequest(`from must be before to, and the range at most ${MAX_FLOW_RANGE_DAYS} days`);
  }
  const by = (stringListParam(req, 'by', ['sender', 'receiver', 'pair'])?.[0] ?? 'sender');
  const kinds = stringListParam(req, 'kinds', KINDS) ?? ['transfer'];
  const limit = intParam(req, 'limit', 25, 1, 200);
  const contracts = await selectContracts(req);
  const groupCols = by === 'sender' ? 'from_address' : by === 'receiver' ? 'to_address' : 'from_address, to_address';
  const rows = await timedQuery<{ from_address?: string; to_address?: string; n: string; units: number; coins: string[] }>(
    `SELECT ${groupCols}, count(*)::text AS n,
            sum(e.amount / power(10::numeric, c.dec))::float8 AS units,
            array_agg(DISTINCT c.ticker) AS coins
     FROM events e
     JOIN unnest($1::uuid[], $2::int[], $3::text[]) AS c(id, dec, ticker) ON e.contract_id = c.id
     WHERE e.timestamp >= $4 AND e.timestamp < $5 AND e.kind = ANY($6::text[]) AND e.amount IS NOT NULL
     GROUP BY ${groupCols}
     ORDER BY units DESC NULLS LAST
     LIMIT $7`,
    [contracts.map(c => c.id), contracts.map(c => c.decimals), contracts.map(c => c.ticker), pgTs(from), pgTs(to), kinds, limit],
    60000
  );
  res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    by,
    flows: rows.map(r => ({ from: r.from_address ?? null, to: r.to_address ?? null, count: Number(r.n), amount_units: r.units, coins: r.coins })),
  });
}));

export default router;
