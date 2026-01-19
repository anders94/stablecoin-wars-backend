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
    -- Allow NULL timestamps for blocks without events
    ALTER TABLE blocks ALTER COLUMN timestamp DROP NOT NULL;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    -- Restore NOT NULL constraint (will fail if there are NULL values)
    ALTER TABLE blocks ALTER COLUMN timestamp SET NOT NULL;
  `);
};

exports._meta = {
  "version": 1
};
