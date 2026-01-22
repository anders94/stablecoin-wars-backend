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
    -- Change total_fees_native from NUMERIC(40, 18) to NUMERIC(40, 0)
    -- Fees are stored in wei (smallest unit) which are always integers
    ALTER TABLE blocks ALTER COLUMN total_fees_native TYPE NUMERIC(40, 0);
    ALTER TABLE metrics ALTER COLUMN total_fees_native TYPE NUMERIC(40, 0);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    -- Revert to NUMERIC(40, 18)
    ALTER TABLE blocks ALTER COLUMN total_fees_native TYPE NUMERIC(40, 18);
    ALTER TABLE metrics ALTER COLUMN total_fees_native TYPE NUMERIC(40, 18);
  `);
};

exports._meta = {
  "version": 1
};
