'use strict';

var dbm;
var type;
var seed;

exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

/**
 * Support for more than one coin:
 * - contracts.initial_supply: supply created without an event (e.g. Tether's constructor mints
 *   its initial supply without emitting one); supply series start from it
 * - contracts.listed: unlisted contracts are indexed but kept out of the public explorer API
 *   (used while a new coin's history is still loading)
 * - fee_backfill_state: progress of the historical fee backfill per contract
 */
exports.up = function(db) {
  return db.runSql(`
    ALTER TABLE contracts
      ADD COLUMN initial_supply NUMERIC(78,0) NOT NULL DEFAULT 0,
      ADD COLUMN listed BOOLEAN NOT NULL DEFAULT true;

    CREATE TABLE fee_backfill_state (
      contract_id UUID PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
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
    DROP TABLE IF EXISTS fee_backfill_state;
    ALTER TABLE contracts DROP COLUMN IF EXISTS listed, DROP COLUMN IF EXISTS initial_supply;
  `);
};

exports._meta = {
  "version": 1
};
