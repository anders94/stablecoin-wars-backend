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

// Get custom timescale metrics for a stablecoin (using block summaries)
router.get('/:ticker/custom', async (req: Request, res: Response) => {
  try {
    const ticker = req.params.ticker as string;
    const { network, from, to, period } = req.query;

    if (!from || !to || !period) {
      return res.status(400).json({ error: 'from, to, and period parameters are required' });
    }

    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use ISO 8601 format.' });
    }

    // Parse period parameter
    let periodSeconds: number;
    let truncFunc: string;

    switch (period) {
      case 'hour':
        periodSeconds = 3600;
        truncFunc = 'hour';
        break;
      case 'day':
        periodSeconds = 86400;
        truncFunc = 'day';
        break;
      case 'week':
        periodSeconds = 604800;
        truncFunc = 'week';
        break;
      case 'month':
        periodSeconds = 2592000;
        truncFunc = 'month';
        break;
      default:
        // Custom period in seconds
        periodSeconds = parseInt(period as string);
        if (isNaN(periodSeconds) || periodSeconds <= 0) {
          return res.status(400).json({
            error: 'Invalid period. Must be "hour", "day", "week", "month", or a positive number of seconds'
          });
        }
        // For custom periods, we'll use epoch-based bucketing
        truncFunc = '';
    }

    // Build query
    let networkFilter = '';
    const params: unknown[] = [ticker.toUpperCase(), fromDate, toDate];

    if (network) {
      networkFilter = 'AND n.name = $4';
      params.push((network as string).toLowerCase());
    }

    // Query blocks and aggregate by period
    let periodGrouping: string;
    if (truncFunc) {
      periodGrouping = `date_trunc('${truncFunc}', b.timestamp)`;
    } else {
      // For custom periods, bucket by epoch seconds
      periodGrouping = `to_timestamp(floor(extract(epoch from b.timestamp) / ${periodSeconds}) * ${periodSeconds})`;
    }

    const metricsData = await query<{
      period_start: Date;
      network_name: string;
      total_supply: string | null;
      minted: string;
      burned: string;
      tx_count: number;
      total_transferred: string;
      total_fees_native: string;
    }>(
      `SELECT
         ${periodGrouping} as period_start,
         n.name as network_name,
         MAX(b.total_supply) as total_supply,
         SUM(b.minted) as minted,
         SUM(b.burned) as burned,
         SUM(b.tx_count) as tx_count,
         SUM(b.total_transferred) as total_transferred,
         SUM(b.total_fees_native) as total_fees_native
       FROM blocks b
       JOIN contracts ct ON b.contract_id = ct.id
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       WHERE UPPER(s.ticker) = $1
         AND b.timestamp >= $2
         AND b.timestamp < $3
         ${networkFilter}
       GROUP BY period_start, n.name
       ORDER BY period_start, n.name`,
      params
    );

    // Query unique addresses per period
    const addressData = await query<{
      period_start: Date;
      network_name: string;
      unique_senders: number;
      unique_receivers: number;
    }>(
      `SELECT
         ${periodGrouping} as period_start,
         n.name as network_name,
         COUNT(DISTINCT CASE WHEN ba.address_type IN ('sender', 'both') THEN ba.address END) as unique_senders,
         COUNT(DISTINCT CASE WHEN ba.address_type IN ('receiver', 'both') THEN ba.address END) as unique_receivers
       FROM blocks b
       JOIN contracts ct ON b.contract_id = ct.id
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       LEFT JOIN block_addresses ba ON b.id = ba.block_id
       WHERE UPPER(s.ticker) = $1
         AND b.timestamp >= $2
         AND b.timestamp < $3
         ${networkFilter}
       GROUP BY period_start, n.name
       ORDER BY period_start, n.name`,
      params
    );

    // Merge address data into metrics data
    const addressMap = new Map<string, { unique_senders: number; unique_receivers: number }>();
    for (const row of addressData) {
      const key = `${row.period_start.toISOString()}_${row.network_name}`;
      addressMap.set(key, {
        unique_senders: row.unique_senders,
        unique_receivers: row.unique_receivers,
      });
    }

    // Group by period and aggregate across networks
    const periodMap = new Map<string, MetricsDataPoint>();

    for (const row of metricsData) {
      const periodKey = row.period_start.toISOString();
      const addressKey = `${periodKey}_${row.network_name}`;
      const addressInfo = addressMap.get(addressKey) || { unique_senders: 0, unique_receivers: 0 };

      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          period_start: periodKey,
          networks: {},
          total: {
            total_supply: '0',
            minted: '0',
            burned: '0',
            tx_count: 0,
            unique_senders: 0,
            unique_receivers: 0,
            total_transferred: '0',
            total_fees_native: '0',
            total_fees_usd: '0',
          },
        });
      }

      const dataPoint = periodMap.get(periodKey)!;

      // Add network-specific data
      const networkMetrics: MetricsValues = {
        total_supply: row.total_supply ?? undefined,
        minted: row.minted,
        burned: row.burned,
        tx_count: row.tx_count,
        unique_senders: addressInfo.unique_senders,
        unique_receivers: addressInfo.unique_receivers,
        total_transferred: row.total_transferred,
        total_fees_native: row.total_fees_native,
        total_fees_usd: '0', // Not calculated in block summaries yet
      };
      dataPoint.networks[row.network_name] = networkMetrics;

      // Aggregate totals
      const total = dataPoint.total;
      total.total_supply = (BigInt(total.total_supply || '0') + BigInt(row.total_supply || '0')).toString();
      total.minted = (BigInt(total.minted || '0') + BigInt(row.minted || '0')).toString();
      total.burned = (BigInt(total.burned || '0') + BigInt(row.burned || '0')).toString();
      total.tx_count = (total.tx_count || 0) + (row.tx_count || 0);
      total.unique_senders = (total.unique_senders || 0) + addressInfo.unique_senders;
      total.unique_receivers = (total.unique_receivers || 0) + addressInfo.unique_receivers;
      total.total_transferred = (BigInt(total.total_transferred || '0') + BigInt(row.total_transferred || '0')).toString();
      total.total_fees_native = (BigInt(total.total_fees_native || '0') + BigInt(row.total_fees_native || '0')).toString();
    }

    const response: MetricsResponse = {
      ticker: ticker.toUpperCase(),
      resolution_seconds: periodSeconds,
      data: Array.from(periodMap.values()),
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching custom metrics:', error);
    res.status(500).json({ error: 'Failed to fetch custom metrics' });
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
