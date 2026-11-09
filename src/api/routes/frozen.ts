/**
 * GET /api/frozen?coins&networks&address
 *
 * The addresses on each selected contract's blacklist now (kept by the indexer in
 * frozen_addresses), with their balance in whole tokens, per-contract totals, and the number of
 * frozen addresses over time (one point per day on which it changed). With `address`, only that
 * address's rows are returned and the history is left out.
 *
 * Each token contract keeps its own blacklist, even for one issuer, so rows are per contract;
 * the same address frozen on several contracts appears once per contract.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../../db';
import { BadRequest, selectContracts, isoTs, toUnits, normalizeAddressParam } from '../helpers';
import { getEventSet, freezeListEventNames, destroyedFundsEventNames } from '../../indexer/eventSets';

const router = Router();

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(error => {
      if (error instanceof BadRequest) res.status(400).json({ error: error.message });
      else next(error);
    });
  };
}

router.get('/frozen', wrap(async (req, res) => {
  const address = req.query.address ? normalizeAddressParam(String(req.query.address)) : null;
  const contracts = (await selectContracts(req)).filter(c => freezeListEventNames(getEventSet(c.event_set)).add.length > 0);
  const byId = new Map(contracts.map(c => [c.id, c]));
  const ids = contracts.map(c => c.id);

  const rows = await query<{
    contract_id: string; address: string; frozen_at: Date; frozen_block: string; frozen_tx: string;
    times_frozen: number; balance: string | null; destroyed: string; balance_block: string | null; updated_at: Date;
  }>(
    `SELECT contract_id, address, frozen_at, frozen_block, frozen_tx, times_frozen, balance::text, destroyed::text,
            balance_block, updated_at
     FROM frozen_addresses
     WHERE contract_id = ANY($1::uuid[]) AND ($2::text IS NULL OR address = $2)
     ORDER BY balance DESC NULLS LAST, frozen_at DESC`,
    [ids, address]
  );

  // Per contract: current totals, everything ever destroyed, and when the list was last refreshed
  const totals = new Map(contracts.map(c => [c.id, {
    contract_id: c.id, ticker: c.ticker, network: c.network,
    addresses: 0, balance_units: 0, destroyed_units: 0, balance_block: null as number | null, updated_at: null as string | null,
  }]));
  for (const r of rows) {
    const t = totals.get(r.contract_id)!;
    const c = byId.get(r.contract_id)!;
    t.addresses++;
    t.balance_units += toUnits(r.balance, c.decimals) ?? 0;
    t.balance_block = r.balance_block === null ? t.balance_block : Number(r.balance_block);
    const updated = isoTs(r.updated_at);
    if (!t.updated_at || (updated && updated > t.updated_at)) t.updated_at = updated;
  }

  let history: { t: string; counts: Record<string, number> }[] | null = null;
  if (!address) {
    for (const c of contracts) {
      const names = destroyedFundsEventNames(getEventSet(c.event_set));
      if (names.length === 0) continue;
      const [d] = await query<{ amount: string | null }>(
        `SELECT sum(amount)::text AS amount FROM events WHERE contract_id = $1 AND kind = 'burn' AND event_name = ANY($2::text[])`,
        [c.id, names]
      );
      totals.get(c.id)!.destroyed_units = toUnits(d?.amount ?? null, c.decimals) ?? 0;
    }
    history = await frozenHistory(ids);
  } else {
    for (const r of rows) totals.get(r.contract_id)!.destroyed_units += toUnits(r.destroyed, byId.get(r.contract_id)!.decimals) ?? 0;
  }

  res.json({
    rows: rows.map(r => {
      const c = byId.get(r.contract_id)!;
      return {
        contract_id: r.contract_id,
        ticker: c.ticker,
        network: c.network,
        address: r.address,
        frozen_at: isoTs(r.frozen_at),
        frozen_block: Number(r.frozen_block),
        frozen_tx: r.frozen_tx,
        times_frozen: r.times_frozen,
        balance_units: toUnits(r.balance, c.decimals),
        destroyed_units: toUnits(r.destroyed, c.decimals) ?? 0,
      };
    }),
    totals: [...totals.values()],
    history,
  });
}));

/**
 * Number of frozen addresses per contract at the end of each day on which it changed, replayed
 * from the add/remove events (a few thousand rows). Every point carries every contract's count.
 */
export async function frozenHistory(ids: string[]) {
  const names = freezeListEventNames();
  const events = await query<{ contract_id: string; address: string; event_name: string; day: Date }>(
    `SELECT contract_id, to_address AS address, event_name, date_trunc('day', timestamp) AS day
     FROM events
     WHERE contract_id = ANY($1::uuid[]) AND kind = 'admin' AND to_address IS NOT NULL
       AND event_name = ANY($2::text[])
     ORDER BY timestamp, block_number, log_index`,
    [ids, [...names.add, ...names.remove]]
  );
  const adds = new Set(names.add);
  const frozen = new Map(ids.map(id => [id, new Set<string>()]));
  const points: { t: string; counts: Record<string, number> }[] = [];
  const counts = () => Object.fromEntries(ids.map(id => [id, frozen.get(id)!.size]));
  let day: string | null = null;
  for (const e of events) {
    const d = isoTs(e.day)!;
    if (day !== null && d !== day) points.push({ t: day, counts: counts() });
    day = d;
    const set = frozen.get(e.contract_id)!;
    if (adds.has(e.event_name)) set.add(e.address); else set.delete(e.address);
  }
  if (day !== null) points.push({ t: day, counts: counts() });
  return points;
}

export default router;
