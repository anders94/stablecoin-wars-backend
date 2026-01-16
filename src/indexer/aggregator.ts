import { query, execute, queryOne } from '../db';
import { RESOLUTIONS, Metrics } from '../types';

// Aggregation levels (powers of 10 based on daily resolution)
const AGGREGATION_LEVELS = [
  { source: RESOLUTIONS.DAY, target: RESOLUTIONS.TEN_DAYS, count: 10 },
  { source: RESOLUTIONS.TEN_DAYS, target: RESOLUTIONS.HUNDRED_DAYS, count: 10 },
  { source: RESOLUTIONS.HUNDRED_DAYS, target: RESOLUTIONS.THOUSAND_DAYS, count: 10 },
];

export async function aggregateMetrics(contractId?: string): Promise<void> {
  console.log('Running metrics aggregation...');

  for (const level of AGGREGATION_LEVELS) {
    await aggregateLevel(level.source, level.target, level.count, contractId);
  }

  console.log('Metrics aggregation complete');
}

async function aggregateLevel(
  sourceResolution: number,
  targetResolution: number,
  periodsToAggregate: number,
  contractId?: string
): Promise<void> {
  console.log(`Aggregating ${sourceResolution}s -> ${targetResolution}s (${periodsToAggregate} periods)`);

  // Get contracts that need aggregation
  const contractFilter = contractId ? 'AND contract_id = $1' : '';
  const params = contractId ? [contractId] : [];

  // Find source periods that haven't been aggregated yet
  const pendingAggregations = await query<{
    contract_id: string;
    period_group: Date;
    period_count: string;
  }>(
    `WITH source_periods AS (
      SELECT
        contract_id,
        -- Group periods into target resolution buckets
        date_trunc('day', period_start) -
          (EXTRACT(EPOCH FROM date_trunc('day', period_start))::bigint % $${params.length + 1})::int * interval '1 second'
          AS period_group,
        period_start
      FROM metrics
      WHERE resolution_seconds = $${params.length + 2}
      ${contractFilter}
    ),
    grouped AS (
      SELECT
        contract_id,
        period_group,
        COUNT(*) as period_count
      FROM source_periods
      GROUP BY contract_id, period_group
    )
    SELECT contract_id, period_group, period_count
    FROM grouped
    WHERE period_count >= $${params.length + 3}
      AND NOT EXISTS (
        SELECT 1 FROM metrics m
        WHERE m.contract_id = grouped.contract_id
          AND m.resolution_seconds = $${params.length + 4}
          AND m.period_start = grouped.period_group
      )
    ORDER BY period_group`,
    [...params, targetResolution, sourceResolution, periodsToAggregate, targetResolution]
  );

  console.log(`Found ${pendingAggregations.length} periods to aggregate`);

  for (const pending of pendingAggregations) {
    await aggregatePeriod(
      pending.contract_id,
      pending.period_group,
      sourceResolution,
      targetResolution
    );
  }
}

async function aggregatePeriod(
  contractId: string,
  periodStart: Date,
  sourceResolution: number,
  targetResolution: number
): Promise<void> {
  // Calculate the end of this target period
  const periodEnd = new Date(periodStart.getTime() + targetResolution * 1000);

  // Aggregate source metrics within this period
  const aggregated = await queryOne<{
    total_supply: string | null;
    total_minted: string;
    total_burned: string;
    total_tx_count: string;
    total_unique_senders: string;
    total_unique_receivers: string;
    total_transferred: string;
    total_fees_native: string;
    total_fees_usd: string;
    min_start_block: number;
    max_end_block: number;
  }>(
    `SELECT
      (SELECT total_supply FROM metrics
       WHERE contract_id = $1 AND resolution_seconds = $2 AND period_start < $4
       ORDER BY period_start DESC LIMIT 1) as total_supply,
      COALESCE(SUM(minted), 0) as total_minted,
      COALESCE(SUM(burned), 0) as total_burned,
      COALESCE(SUM(tx_count), 0) as total_tx_count,
      COALESCE(SUM(unique_senders), 0) as total_unique_senders,
      COALESCE(SUM(unique_receivers), 0) as total_unique_receivers,
      COALESCE(SUM(total_transferred), 0) as total_transferred,
      COALESCE(SUM(total_fees_native), 0) as total_fees_native,
      COALESCE(SUM(total_fees_usd), 0) as total_fees_usd,
      MIN(start_block) as min_start_block,
      MAX(end_block) as max_end_block
    FROM metrics
    WHERE contract_id = $1
      AND resolution_seconds = $2
      AND period_start >= $3
      AND period_start < $4`,
    [contractId, sourceResolution, periodStart, periodEnd]
  );

  if (!aggregated) {
    return;
  }

  // Insert aggregated metrics
  await execute(
    `INSERT INTO metrics (
      contract_id, period_start, resolution_seconds,
      total_supply, minted, burned, tx_count,
      unique_senders, unique_receivers,
      total_transferred, total_fees_native, total_fees_usd,
      start_block, end_block
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (contract_id, period_start, resolution_seconds)
    DO UPDATE SET
      total_supply = EXCLUDED.total_supply,
      minted = EXCLUDED.minted,
      burned = EXCLUDED.burned,
      tx_count = EXCLUDED.tx_count,
      unique_senders = EXCLUDED.unique_senders,
      unique_receivers = EXCLUDED.unique_receivers,
      total_transferred = EXCLUDED.total_transferred,
      total_fees_native = EXCLUDED.total_fees_native,
      total_fees_usd = EXCLUDED.total_fees_usd,
      start_block = EXCLUDED.start_block,
      end_block = EXCLUDED.end_block,
      updated_at = NOW()`,
    [
      contractId,
      periodStart,
      targetResolution,
      aggregated.total_supply,
      aggregated.total_minted,
      aggregated.total_burned,
      parseInt(aggregated.total_tx_count),
      parseInt(aggregated.total_unique_senders),
      parseInt(aggregated.total_unique_receivers),
      aggregated.total_transferred,
      aggregated.total_fees_native,
      aggregated.total_fees_usd,
      aggregated.min_start_block,
      aggregated.max_end_block,
    ]
  );
}

// Run aggregation for all contracts
export async function runFullAggregation(): Promise<void> {
  const contracts = await query<{ id: string }>('SELECT id FROM contracts WHERE is_active = true');

  for (const contract of contracts) {
    try {
      await aggregateMetrics(contract.id);
    } catch (error) {
      console.error(`Error aggregating metrics for contract ${contract.id}:`, error);
    }
  }
}
