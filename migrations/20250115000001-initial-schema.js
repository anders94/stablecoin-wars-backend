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
    -- Stablecoin issuers
    CREATE TABLE companies (
      id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid() PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      website TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Stablecoin tokens
    CREATE TABLE stablecoins (
      id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid() PRIMARY KEY,
      company_id UUID REFERENCES companies(id),
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      decimals INTEGER DEFAULT 18,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(company_id, ticker)
    );

    -- Supported blockchain networks
    CREATE TABLE networks (
      id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid() PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      chain_type TEXT NOT NULL,
      chain_id TEXT,
      block_time_seconds INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Stablecoin deployments on networks
    CREATE TABLE contracts (
      id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid() PRIMARY KEY,
      stablecoin_id UUID REFERENCES stablecoins(id),
      network_id UUID REFERENCES networks(id),
      contract_address TEXT NOT NULL,
      rpc_endpoint TEXT NOT NULL,
      creation_block BIGINT,
      creation_date TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(network_id, contract_address)
    );

    -- Sync state per contract
    CREATE TABLE sync_state (
      id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid() PRIMARY KEY,
      contract_id UUID REFERENCES contracts(id) UNIQUE,
      last_synced_block BIGINT DEFAULT 0,
      last_synced_at TIMESTAMP,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Unified metrics table with resolution-based aggregation
    CREATE TABLE metrics (
      id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid() PRIMARY KEY,
      contract_id UUID REFERENCES contracts(id),
      period_start TIMESTAMP NOT NULL,
      resolution_seconds INTEGER NOT NULL,
      total_supply NUMERIC(40, 0),
      minted NUMERIC(40, 0) DEFAULT 0,
      burned NUMERIC(40, 0) DEFAULT 0,
      tx_count INTEGER DEFAULT 0,
      unique_senders INTEGER DEFAULT 0,
      unique_receivers INTEGER DEFAULT 0,
      total_transferred NUMERIC(40, 0) DEFAULT 0,
      total_fees_native NUMERIC(40, 18) DEFAULT 0,
      total_fees_usd NUMERIC(24, 6) DEFAULT 0,
      start_block BIGINT,
      end_block BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(contract_id, period_start, resolution_seconds)
    );

    -- Indexes for efficient queries
    CREATE INDEX idx_metrics_contract_resolution ON metrics(contract_id, resolution_seconds);
    CREATE INDEX idx_metrics_period ON metrics(period_start, resolution_seconds);
    CREATE INDEX idx_metrics_contract_period_res ON metrics(contract_id, period_start, resolution_seconds);
    CREATE INDEX idx_contracts_stablecoin ON contracts(stablecoin_id);
    CREATE INDEX idx_contracts_network ON contracts(network_id);
    CREATE INDEX idx_stablecoins_ticker ON stablecoins(ticker);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS metrics CASCADE;
    DROP TABLE IF EXISTS sync_state CASCADE;
    DROP TABLE IF EXISTS contracts CASCADE;
    DROP TABLE IF EXISTS networks CASCADE;
    DROP TABLE IF EXISTS stablecoins CASCADE;
    DROP TABLE IF EXISTS companies CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
