'use strict';

var dbm;
var type;
var seed;

exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

exports.up = function(db) {
  return db.runSql(`
    -- Drop old block summary tables
    DROP TABLE IF EXISTS block_addresses CASCADE;
    DROP TABLE IF EXISTS block_summaries CASCADE;

    -- Individual block summaries for maximum flexibility
    CREATE TABLE blocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id UUID NOT NULL REFERENCES contracts(id),

      -- Single block info
      block_number BIGINT NOT NULL,
      timestamp TIMESTAMP NOT NULL,

      -- Aggregate metrics for this block
      minted NUMERIC(40, 0) DEFAULT 0,
      burned NUMERIC(40, 0) DEFAULT 0,
      tx_count INTEGER DEFAULT 0,
      total_transferred NUMERIC(40, 0) DEFAULT 0,
      total_fees_native NUMERIC(40, 18) DEFAULT 0,
      total_supply NUMERIC(40, 0),  -- Snapshot at this block

      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),

      UNIQUE(contract_id, block_number)
    );

    -- Indexes for efficient time-based and block-based queries
    CREATE INDEX idx_blocks_contract_time ON blocks(contract_id, timestamp);
    CREATE INDEX idx_blocks_contract_block ON blocks(contract_id, block_number);
    CREATE INDEX idx_blocks_timestamp ON blocks(timestamp);

    -- Track unique addresses per block
    CREATE TABLE block_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id UUID NOT NULL REFERENCES contracts(id),
      block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      address_type TEXT NOT NULL CHECK (address_type IN ('sender', 'receiver', 'both')),
      created_at TIMESTAMP DEFAULT NOW(),

      UNIQUE(block_id, address)
    );

    -- Indexes for efficient address queries
    CREATE INDEX idx_block_addresses_block ON block_addresses(block_id);
    CREATE INDEX idx_block_addresses_contract ON block_addresses(contract_id);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS block_addresses CASCADE;
    DROP TABLE IF EXISTS blocks CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
