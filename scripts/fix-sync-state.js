#!/usr/bin/env node

/**
 * Helper script to ensure all contracts have corresponding sync_state entries
 * Run this after clearing the database or adding new contracts manually
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'stablecoin_wars',
});

async function fixSyncState() {
  try {
    console.log('Checking for contracts missing sync_state entries...');

    // Get all contracts with their sync state
    const contracts = await pool.query(`
      SELECT
        c.id,
        s.name as stablecoin,
        n.name as network,
        ss.id as sync_state_id
      FROM contracts c
      JOIN stablecoins s ON c.stablecoin_id = s.id
      JOIN networks n ON c.network_id = n.id
      LEFT JOIN sync_state ss ON c.id = ss.contract_id
    `);

    let fixed = 0;
    let existing = 0;

    for (const contract of contracts.rows) {
      if (!contract.sync_state_id) {
        // Create missing sync_state entry
        await pool.query(
          `INSERT INTO sync_state (contract_id, last_synced_block, status)
           VALUES ($1, 0, 'pending')`,
          [contract.id]
        );
        console.log(`✓ Created sync_state for ${contract.stablecoin} on ${contract.network}`);
        fixed++;
      } else {
        existing++;
      }
    }

    console.log('\nSummary:');
    console.log(`  Total contracts: ${contracts.rows.length}`);
    console.log(`  Already had sync_state: ${existing}`);
    console.log(`  Created new sync_state: ${fixed}`);

    if (fixed > 0) {
      console.log('\n✓ Sync state entries created. You can now start the indexer.');
    } else {
      console.log('\n✓ All contracts already have sync_state entries.');
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

fixSyncState();
