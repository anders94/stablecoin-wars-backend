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
    -- Block-level summaries for arbitrary timescale metrics
    CREATE TABLE block_summaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id UUID NOT NULL REFERENCES contracts(id),

      -- Block range (100 blocks per summary)
      start_block BIGINT NOT NULL,
      end_block BIGINT NOT NULL,

      -- Time range (derived from block timestamps)
      start_timestamp TIMESTAMP NOT NULL,
      end_timestamp TIMESTAMP NOT NULL,

      -- Aggregate metrics
      minted NUMERIC(40, 0) DEFAULT 0,
      burned NUMERIC(40, 0) DEFAULT 0,
      tx_count INTEGER DEFAULT 0,
      total_transferred NUMERIC(40, 0) DEFAULT 0,
      total_fees_native NUMERIC(40, 18) DEFAULT 0,
      total_supply NUMERIC(40, 0),  -- Snapshot at end_block

      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),

      UNIQUE(contract_id, start_block)
    );

    -- Indexes for efficient time-based and block-based queries
    CREATE INDEX idx_block_summaries_contract_time ON block_summaries(contract_id, start_timestamp, end_timestamp);
    CREATE INDEX idx_block_summaries_contract_block ON block_summaries(contract_id, start_block, end_block);

    -- Track unique addresses per block summary
    CREATE TABLE block_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id UUID NOT NULL REFERENCES contracts(id),
      block_summary_id UUID NOT NULL REFERENCES block_summaries(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      address_type TEXT NOT NULL CHECK (address_type IN ('sender', 'receiver', 'both')),
      created_at TIMESTAMP DEFAULT NOW(),

      UNIQUE(block_summary_id, address)
    );

    -- Indexes for efficient address queries
    CREATE INDEX idx_block_addresses_summary ON block_addresses(block_summary_id);
    CREATE INDEX idx_block_addresses_contract ON block_addresses(contract_id);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS block_addresses CASCADE;
    DROP TABLE IF EXISTS block_summaries CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
