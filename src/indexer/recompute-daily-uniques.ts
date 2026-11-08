/**
 * Recount the daily unique senders and receivers of contracts exactly from the events table.
 *
 * Daily metrics used to add up each indexed chunk's own distinct counts, so an address active in
 * several chunks of a day was counted several times. The live sync now recounts the days it
 * touches; this corrects the history (and is what `backfill-events --full` runs when it finishes).
 * Senders are the sources of transfers and burns, receivers the destinations of transfers and
 * mints. Each day is its own short transaction, so it is safe to stop and re-run at any time,
 * alongside the indexer.
 *
 * Usage:
 *   ts-node src/indexer/recompute-daily-uniques.ts <contract-id>... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 */
import dotenv from 'dotenv';
dotenv.config();

import { query, transaction, withDatabaseRetry, closePool } from '../db';
import { RESOLUTIONS } from '../types';
import { recountDailyUniques } from './processor';
import { isShutdownRequested, requestShutdown } from './shutdown';

export async function recountAllDailyUniques(
  contractId: string,
  progress: (day: string, done: number, total: number) => void = () => {},
  range: { from?: string; to?: string } = {}
): Promise<number> {
  const days = await query<{ day: string }>(
    `SELECT to_char(period_start, 'YYYY-MM-DD') AS day FROM metrics
     WHERE contract_id = $1 AND resolution_seconds = $2
       AND ($3::date IS NULL OR period_start >= $3::date) AND ($4::date IS NULL OR period_start <= $4::date)
     ORDER BY period_start`,
    [contractId, RESOLUTIONS.DAY, range.from ?? null, range.to ?? null]
  );
  let done = 0;
  for (const { day } of days) {
    if (isShutdownRequested()) break;
    await withDatabaseRetry(`recount of ${day}`, () => transaction(client => recountDailyUniques(client, contractId, day)));
    progress(day, ++done, days.length);
  }
  return done;
}

async function main() {
  const args = process.argv.slice(2);
  const contractIds: string[] = [];
  const range: { from?: string; to?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') range.from = args[++i];
    else if (args[i] === '--to') range.to = args[++i];
    else if (/^[0-9a-f-]{36}$/i.test(args[i])) contractIds.push(args[i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (contractIds.length === 0) {
    throw new Error('Usage: recompute-daily-uniques.ts <contract-id>... [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
  }

  const onSignal = () => {
    if (isShutdownRequested()) process.exit(1);
    console.log('Stopping after the current day (signal again to exit now)');
    requestShutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (const id of contractIds) {
    const started = Date.now();
    const n = await recountAllDailyUniques(id, (day, done, total) => {
      if (done % 100 === 0 || done === total) {
        console.log(`${id}: ${done}/${total} days (${day}), ${Math.round((Date.now() - started) / 1000)}s`);
      }
    }, range);
    console.log(`${id}: recounted ${n} days`);
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
