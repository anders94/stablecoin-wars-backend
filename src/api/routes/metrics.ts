import { Router, Request, Response } from 'express';
import { query, queryOne } from '../../db';
import { RESOLUTIONS, MetricsQueryParams, MetricsResponse, MetricsDataPoint, MetricsValues } from '../../types';

const router = Router();

// Auto-select resolution based on date range
function autoSelectResolution(fromDate: Date, toDate: Date): number {
  const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);

  if (diffDays < 30) return RESOLUTIONS.DAY;
  if (diffDays < 300) return RESOLUTIONS.TEN_DAYS;
  if (diffDays < 3000) return RESOLUTIONS.HUNDRED_DAYS;
  return RESOLUTIONS.THOUSAND_DAYS;
}

// Get metrics for a stablecoin
router.get('/:ticker', async (req: Request, res: Response) => {
  try {
    const ticker = req.params.ticker as string;
    const { network, from, to, resolution, metrics } = req.query as unknown as MetricsQueryParams;

    if (!from || !to) {
      return res.status(400).json({ error: 'from and to date parameters are required' });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use ISO 8601 format.' });
    }

    // Determine resolution
    let resolutionSeconds: number;
    if (!resolution || resolution === 'auto') {
      resolutionSeconds = autoSelectResolution(fromDate, toDate);
    } else {
      resolutionSeconds = typeof resolution === 'string' ? parseInt(resolution) : resolution;
      if (!Object.values(RESOLUTIONS).includes(resolutionSeconds as 86400 | 864000 | 8640000 | 86400000)) {
        return res.status(400).json({
          error: `Invalid resolution. Must be one of: ${Object.values(RESOLUTIONS).join(', ')}`
        });
      }
    }

    // Parse requested metrics
    const requestedMetrics = metrics?.split(',').map(m => m.trim()) || [
      'total_supply', 'minted', 'burned', 'tx_count', 'total_transferred', 'total_fees_usd'
    ];

    // Build query
    let networkFilter = '';
    const params: unknown[] = [ticker.toUpperCase(), fromDate, toDate, resolutionSeconds];

    if (network) {
      networkFilter = 'AND n.name = $5';
      params.push(network.toLowerCase());
    }

    const metricsData = await query<{
      period_start: Date;
      network_name: string;
      total_supply: string | null;
      minted: string;
      burned: string;
      tx_count: number;
      unique_senders: number;
      unique_receivers: number;
      total_transferred: string;
      total_fees_native: string;
      total_fees_usd: string;
    }>(
      `SELECT
         m.period_start,
         n.name as network_name,
         m.total_supply,
         m.minted,
         m.burned,
         m.tx_count,
         m.unique_senders,
         m.unique_receivers,
         m.total_transferred,
         m.total_fees_native,
         m.total_fees_usd
       FROM metrics m
       JOIN contracts ct ON m.contract_id = ct.id
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       WHERE UPPER(s.ticker) = $1
         AND m.period_start >= $2
         AND m.period_start < $3
         AND m.resolution_seconds = $4
         ${networkFilter}
       ORDER BY m.period_start, n.name`,
      params
    );

    // Group by period and aggregate across networks
    const periodMap = new Map<string, MetricsDataPoint>();

    for (const row of metricsData) {
      const periodKey = row.period_start.toISOString();

      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          period_start: periodKey,
          networks: {},
          total: createEmptyMetrics(requestedMetrics),
        });
      }

      const dataPoint = periodMap.get(periodKey)!;

      // Add network-specific data
      const networkMetrics = filterMetrics(row, requestedMetrics);
      dataPoint.networks[row.network_name] = networkMetrics;

      // Aggregate totals
      aggregateMetrics(dataPoint.total, networkMetrics, requestedMetrics);
    }

    const response: MetricsResponse = {
      ticker: ticker.toUpperCase(),
      resolution_seconds: resolutionSeconds,
      data: Array.from(periodMap.values()),
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// Get available date range for a stablecoin
router.get('/:ticker/range', async (req: Request, res: Response) => {
  try {
    const ticker = req.params.ticker as string;

    const range = await queryOne<{ min_date: Date; max_date: Date; total_records: string }>(
      `SELECT
         MIN(m.period_start) as min_date,
         MAX(m.period_start) as max_date,
         COUNT(*) as total_records
       FROM metrics m
       JOIN contracts ct ON m.contract_id = ct.id
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       WHERE UPPER(s.ticker) = $1
         AND m.resolution_seconds = $2`,
      [ticker.toUpperCase(), RESOLUTIONS.DAY]
    );

    if (!range || !range.min_date) {
      return res.status(404).json({ error: 'No data available for this stablecoin' });
    }

    res.json({
      ticker: ticker.toUpperCase(),
      earliest: range.min_date,
      latest: range.max_date,
      total_days: parseInt(range.total_records),
    });
  } catch (error) {
    console.error('Error fetching date range:', error);
    res.status(500).json({ error: 'Failed to fetch date range' });
  }
});

// Helper functions
function createEmptyMetrics(fields: string[]): MetricsValues {
  const metrics: MetricsValues = {};
  for (const field of fields) {
    if (field === 'tx_count' || field === 'unique_senders' || field === 'unique_receivers') {
      (metrics as Record<string, number>)[field] = 0;
    } else {
      (metrics as Record<string, string>)[field] = '0';
    }
  }
  return metrics;
}

function filterMetrics(row: Record<string, unknown>, fields: string[]): MetricsValues {
  const metrics: MetricsValues = {};
  for (const field of fields) {
    if (field in row) {
      (metrics as Record<string, unknown>)[field] = row[field];
    }
  }
  return metrics;
}

function aggregateMetrics(total: MetricsValues, network: MetricsValues, fields: string[]): void {
  for (const field of fields) {
    if (field === 'total_supply') {
      // For supply, take max (approximate total across networks)
      const current = BigInt((total as Record<string, string>)[field] || '0');
      const add = BigInt((network as Record<string, string>)[field] || '0');
      (total as Record<string, string>)[field] = (current + add).toString();
    } else if (field === 'tx_count' || field === 'unique_senders' || field === 'unique_receivers') {
      (total as Record<string, number>)[field] =
        ((total as Record<string, number>)[field] || 0) +
        ((network as Record<string, number>)[field] || 0);
    } else {
      // Sum numeric string values
      const current = BigInt((total as Record<string, string>)[field] || '0');
      const add = BigInt((network as Record<string, string>)[field] || '0');
      (total as Record<string, string>)[field] = (current + add).toString();
    }
  }
}

export default router;
