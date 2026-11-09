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
 * frozen_addresses: the addresses on each contract's blacklist now, with their token balance.
 * Rebuilt by the indexer (src/indexer/frozen.ts) from the freeze events and balanceOf calls.
 */
exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE frozen_addresses (
      contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      frozen_at TIMESTAMP NOT NULL,
      frozen_block BIGINT NOT NULL,
      frozen_tx TEXT NOT NULL,
      times_frozen INTEGER NOT NULL,
      balance NUMERIC(78,0),
      destroyed NUMERIC(78,0) NOT NULL DEFAULT 0,
      balance_block BIGINT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (contract_id, address)
    );
    CREATE INDEX idx_frozen_addresses_address ON frozen_addresses (address);
  `);
};

exports.down = function(db) {
  return db.runSql('DROP TABLE IF EXISTS frozen_addresses;');
};

exports._meta = {
  "version": 1
};
