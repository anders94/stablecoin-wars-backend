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
    -- Create rpc_endpoints table
    CREATE TABLE rpc_endpoints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      url TEXT NOT NULL UNIQUE,
      max_requests_per_second INTEGER NOT NULL DEFAULT 10,
      description TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX idx_rpc_endpoints_url ON rpc_endpoints(url);
    CREATE INDEX idx_rpc_endpoints_active ON rpc_endpoints(is_active);

    -- Add new foreign key column to contracts (nullable initially for migration)
    ALTER TABLE contracts ADD COLUMN rpc_endpoint_id UUID REFERENCES rpc_endpoints(id);

    -- Migrate existing data: extract unique RPC endpoints from contracts
    INSERT INTO rpc_endpoints (url, max_requests_per_second, description)
    SELECT DISTINCT
      rpc_endpoint,
      10, -- Default: 10 requests per second
      'Migrated from contracts table'
    FROM contracts
    WHERE rpc_endpoint IS NOT NULL;

    -- Update foreign keys in contracts table
    UPDATE contracts c
    SET rpc_endpoint_id = re.id
    FROM rpc_endpoints re
    WHERE c.rpc_endpoint = re.url;

    -- Verify migration (should have no contracts without endpoint)
    DO $$
    DECLARE
      missing_count INTEGER;
    BEGIN
      SELECT COUNT(*) INTO missing_count
      FROM contracts
      WHERE rpc_endpoint_id IS NULL;

      IF missing_count > 0 THEN
        RAISE EXCEPTION 'Migration failed: % contracts without rpc_endpoint_id', missing_count;
      END IF;
    END $$;

    -- Make column required after migration
    ALTER TABLE contracts ALTER COLUMN rpc_endpoint_id SET NOT NULL;

    -- Keep old rpc_endpoint column temporarily for rollback safety
    -- It will be dropped in a future migration after verification
  `);
};

exports.down = function(db) {
  return db.runSql(`
    -- Restore rpc_endpoint column as primary source
    UPDATE contracts c
    SET rpc_endpoint = re.url
    FROM rpc_endpoints re
    WHERE c.rpc_endpoint_id = re.id;

    -- Drop foreign key column
    ALTER TABLE contracts DROP COLUMN rpc_endpoint_id;

    -- Drop indexes
    DROP INDEX IF EXISTS idx_rpc_endpoints_active;
    DROP INDEX IF EXISTS idx_rpc_endpoints_url;

    -- Drop rpc_endpoints table
    DROP TABLE IF EXISTS rpc_endpoints CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
