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
    -- Convert existing per-second values to per-minute (multiply by 60)
    UPDATE rpc_endpoints
    SET max_requests_per_second = max_requests_per_second * 60;

    -- Rename column from max_requests_per_second to max_requests_per_minute
    ALTER TABLE rpc_endpoints
    RENAME COLUMN max_requests_per_second TO max_requests_per_minute;

    -- Update default value for new rows
    ALTER TABLE rpc_endpoints
    ALTER COLUMN max_requests_per_minute SET DEFAULT 600;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    -- Rename column back
    ALTER TABLE rpc_endpoints
    RENAME COLUMN max_requests_per_minute TO max_requests_per_second;

    -- Convert per-minute values back to per-second (divide by 60)
    UPDATE rpc_endpoints
    SET max_requests_per_second = max_requests_per_second / 60;

    -- Restore default value
    ALTER TABLE rpc_endpoints
    ALTER COLUMN max_requests_per_second SET DEFAULT 10;
  `);
};

exports._meta = {
  "version": 1
};
