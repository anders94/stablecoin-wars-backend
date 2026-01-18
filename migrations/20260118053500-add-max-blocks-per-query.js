'use strict';

var dbm;
var type;
var seed;

/**
  * We receive the dbmigrate dependency from dbmigrate initially.
  * This enables us to not have to rely on NODE_PATH.
  */
exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

exports.up = function(db) {
  return db.runSql(`
    -- Add max_blocks_per_query column with a default of 2000
    -- Some RPC providers (like QuickNode discover plan) limit eth_getLogs to very few blocks (e.g., 5)
    -- while others allow 2000+ blocks per query
    ALTER TABLE rpc_endpoints
    ADD COLUMN max_blocks_per_query INTEGER NOT NULL DEFAULT 2000;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    -- Remove max_blocks_per_query column
    ALTER TABLE rpc_endpoints
    DROP COLUMN max_blocks_per_query;
  `);
};

exports._meta = {
  "version": 1
};
