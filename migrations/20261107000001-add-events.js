'use strict';

var dbm;
var type;
var seed;

exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

// Monthly partitions of the events table cover this range; anything outside lands in events_default
const FIRST_MONTH = [2015, 7];
const LAST_MONTH = [2030, 12];

function monthlyPartitions() {
  const statements = [];
  let [year, month] = FIRST_MONTH;
  while (year < LAST_MONTH[0] || (year === LAST_MONTH[0] && month <= LAST_MONTH[1])) {
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const pad = (m) => String(m).padStart(2, '0');
    statements.push(
      `CREATE TABLE events_y${year}m${pad(month)} PARTITION OF events
         FOR VALUES FROM ('${year}-${pad(month)}-01') TO ('${nextYear}-${pad(nextMonth)}-01');`
    );
    [year, month] = [nextYear, nextMonth];
  }
  return statements.join('\n');
}

exports.up = function(db) {
  return db.runSql(`
    -- Which set of event ABIs to index for a contract (see src/indexer/eventSets.ts)
    ALTER TABLE contracts ADD COLUMN event_set TEXT NOT NULL DEFAULT 'erc20';

    UPDATE contracts c SET event_set = 'fiattoken'
    FROM stablecoins s, networks n
    WHERE c.stablecoin_id = s.id AND c.network_id = n.id
      AND UPPER(s.ticker) = 'USDC' AND n.chain_type = 'evm';

    -- First block the live sync wrote event rows for. Blocks before it are filled in by the
    -- event backfill (src/indexer/backfill-events.ts).
    ALTER TABLE sync_state ADD COLUMN events_from_block BIGINT;

    -- Every indexed log: transfers, mints, burns and administrative events
    CREATE TABLE events (
      contract_id UUID NOT NULL REFERENCES contracts(id),
      timestamp TIMESTAMP NOT NULL,
      block_number BIGINT NOT NULL,
      log_index INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      -- transfer | mint | burn | admin. Mints and burns change supply; admin events do not.
      kind TEXT NOT NULL CHECK (kind IN ('transfer', 'mint', 'burn', 'admin')),
      event_name TEXT NOT NULL,
      -- Administrative grouping (freeze, minter, role, pause, upgrade, issuance, config); NULL for plain Transfer logs
      category TEXT,
      from_address TEXT,
      to_address TEXT,
      -- Token amount in base units
      amount NUMERIC(78, 0),
      -- Decoded event arguments (or raw topics/data when the log could not be decoded)
      args JSONB,
      -- Fee of the whole transaction in the chain's native base unit (shared by every event in
      -- the transaction); NULL for backfilled events
      tx_fee_native NUMERIC(40, 0),
      PRIMARY KEY (contract_id, timestamp, block_number, log_index)
    ) PARTITION BY RANGE (timestamp);

    ${monthlyPartitions()}
    CREATE TABLE events_default PARTITION OF events DEFAULT;

    CREATE INDEX idx_events_tx_hash ON events (tx_hash);
    CREATE INDEX idx_events_from ON events (from_address, timestamp);
    CREATE INDEX idx_events_to ON events (to_address, timestamp);
    CREATE INDEX idx_events_amount ON events (contract_id, amount);
    CREATE INDEX idx_events_block ON events (contract_id, block_number);
    CREATE INDEX idx_events_non_transfer ON events (contract_id, kind, timestamp) WHERE kind <> 'transfer';

    -- Progress of the historical event backfill, which walks backwards from
    -- sync_state.events_from_block - 1 down to the contract's creation block
    CREATE TABLE event_backfill_state (
      contract_id UUID PRIMARY KEY REFERENCES contracts(id),
      -- Lowest block whose events are stored; everything from here up is covered
      low_block BIGINT NOT NULL,
      target_block BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP
    );
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS event_backfill_state;
    DROP TABLE IF EXISTS events CASCADE;
    ALTER TABLE sync_state DROP COLUMN IF EXISTS events_from_block;
    ALTER TABLE contracts DROP COLUMN IF EXISTS event_set;
  `);
};

exports._meta = {
  "version": 1
};
