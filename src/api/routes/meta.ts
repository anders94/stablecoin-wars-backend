import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../../db';
import { RESOLUTIONS } from '../../types';
import { loadContracts, eventCoverageFrom, explorerFor, nativeCurrency, isoTs } from '../helpers';

const router = Router();

/**
 * GET /api/meta
 * Everything the UI needs to start: coins, networks, contracts with sync and event coverage,
 * and the overall data range.
 */
router.get('/meta', (req: Request, res: Response, next: NextFunction) => {
  (async () => {
    const contracts = await loadContracts();
    const range = await query<{ contract_id: string; earliest: Date; latest: Date }>(
      `SELECT contract_id, min(period_start) AS earliest, max(period_start) AS latest
       FROM metrics WHERE resolution_seconds = $1 GROUP BY contract_id`,
      [RESOLUTIONS.DAY]
    );
    const rangeByContract = new Map(range.map(r => [r.contract_id, r]));
    const latestBlockTimes = await query<{ contract_id: string; latest: Date }>(
      `SELECT c.id AS contract_id,
              (SELECT b.timestamp FROM blocks b WHERE b.contract_id = c.id AND b.timestamp IS NOT NULL
               ORDER BY b.block_number DESC LIMIT 1) AS latest
       FROM contracts c`
    );
    const latestByContract = new Map(latestBlockTimes.map(r => [r.contract_id, r.latest]));

    const coins = new Map<string, { ticker: string; name: string; company: string | null; decimals: number }>();
    const networks = new Map<string, { name: string; display_name: string; chain_type: string; fee_unit: string; explorer: ReturnType<typeof explorerFor> }>();
    for (const c of contracts) {
      coins.set(c.ticker, { ticker: c.ticker, name: c.coin_name, company: c.company, decimals: c.decimals });
      networks.set(c.network, {
        name: c.network, display_name: c.network_display, chain_type: c.chain_type,
        fee_unit: nativeCurrency(c.network, c.chain_type).symbol, explorer: explorerFor(c.network),
      });
    }

    const contractRows = contracts.map(c => ({
      id: c.id,
      ticker: c.ticker,
      network: c.network,
      address: c.address,
      decimals: c.decimals,
      is_active: c.is_active,
      creation_block: c.creation_block,
      creation_date: isoTs(c.creation_date),
      sync: {
        status: c.sync_status,
        last_synced_block: c.last_synced_block,
        last_synced_at: isoTs(c.last_synced_at),
        latest_block_time: isoTs(latestByContract.get(c.id) ?? null),
      },
      metrics: {
        earliest_day: isoTs(rangeByContract.get(c.id)?.earliest ?? null),
        latest_day: isoTs(rangeByContract.get(c.id)?.latest ?? null),
      },
      events: {
        // Every event from this block on is stored (null: none yet)
        from_block: eventCoverageFrom(c),
        live_from_block: c.events_from_block,
        backfill_status: c.backfill_status ?? (c.events_from_block !== null && c.creation_block !== null && c.events_from_block <= c.creation_block ? 'complete' : null),
      },
    }));

    const earliest = contractRows.map(c => c.metrics.earliest_day).filter((d): d is string => !!d).sort()[0] ?? null;
    const latest = contractRows.map(c => c.sync.latest_block_time).filter((d): d is string => !!d).sort().pop() ?? null;

    res.json({
      coins: [...coins.values()],
      networks: [...networks.values()],
      contracts: contractRows,
      data_range: { earliest, latest },
    });
  })().catch(next);
});

export default router;
