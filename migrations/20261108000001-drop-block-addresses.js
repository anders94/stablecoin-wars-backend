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
 * Drop block_addresses. Distinct senders and receivers are now counted from the events table,
 * which holds every transfer, mint and burn with its addresses.
 */
exports.up = function(db) {
  return db.runSql(`DROP TABLE IF EXISTS block_addresses;`);
};

// Recreates the table empty; the dropped rows are not restored.
exports.down = function(db) {
  return db.runSql(`
    CREATE TABLE block_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id UUID NOT NULL REFERENCES contracts(id),
      block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      address_type TEXT NOT NULL CHECK (address_type IN ('sender', 'receiver', 'both')),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(block_id, address)
    );
    CREATE INDEX idx_block_addresses_block ON block_addresses(block_id);
    CREATE INDEX idx_block_addresses_contract ON block_addresses(contract_id);
  `);
};

exports._meta = {
  "version": 1
};
