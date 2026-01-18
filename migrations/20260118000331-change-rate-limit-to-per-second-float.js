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
    -- Change column type to NUMERIC to support floating point values
    ALTER TABLE rpc_endpoints
    ALTER COLUMN max_requests_per_minute TYPE NUMERIC USING max_requests_per_minute::numeric;

    -- Convert existing per-minute values to per-second (divide by 60)
    UPDATE rpc_endpoints
    SET max_requests_per_minute = max_requests_per_minute / 60.0;

    -- Rename column from max_requests_per_minute to max_requests_per_second
    ALTER TABLE rpc_endpoints
    RENAME COLUMN max_requests_per_minute TO max_requests_per_second;

    -- Update default value for new rows (10 requests per second)
    ALTER TABLE rpc_endpoints
    ALTER COLUMN max_requests_per_second SET DEFAULT 10;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    -- Rename column back
    ALTER TABLE rpc_endpoints
    RENAME COLUMN max_requests_per_second TO max_requests_per_minute;

    -- Convert per-second values back to per-minute (multiply by 60)
    UPDATE rpc_endpoints
    SET max_requests_per_minute = max_requests_per_minute * 60;

    -- Change column type back to INTEGER (will truncate decimal places)
    ALTER TABLE rpc_endpoints
    ALTER COLUMN max_requests_per_minute TYPE INTEGER USING max_requests_per_minute::integer;

    -- Restore default value (600 requests per minute)
    ALTER TABLE rpc_endpoints
    ALTER COLUMN max_requests_per_minute SET DEFAULT 600;
  `);
};

exports._meta = {
  "version": 1
};
