/**
 * Register a known stablecoin contract so the indexer follows it from the chain head, ready for
 * `backfill-events --full` to load its history.
 *
 * Creates (or reuses) the company, stablecoin and contract rows and a sync_state at the current
 * head minus a few blocks, so the live sync starts there instead of replaying history one chunk
 * at a time. New contracts are unlisted: indexed, but kept out of the public explorer API until
 * their history is loaded and checked (`UPDATE contracts SET listed = true WHERE id = ...`).
 * Running it again changes nothing.
 *
 * Usage:
 *   ts-node src/indexer/register-contract.ts <preset>
 * Presets: usdt-ethereum
 */
import dotenv from 'dotenv';
dotenv.config();

import { createAdapter } from './adapters';
import { queryOne, transaction, closePool } from '../db';

interface Preset {
  company: { name: string; website: string };
  coin: { ticker: string; name: string; decimals: number };
  network: string;
  address: string;
  creationBlock: number;
  eventSet: string;
  // Supply created without an event, in base units
  initialSupply: string;
}

const PRESETS: Record<string, Preset> = {
  'usdt-ethereum': {
    company: { name: 'Tether', website: 'https://tether.to' },
    coin: { ticker: 'USDT', name: 'Tether USD', decimals: 6 },
    network: 'ethereum',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    creationBlock: 4634748,
    eventSet: 'tether',
    // The constructor sets a 100,000 USDT initial supply without emitting an event
    initialSupply: '100000000000',
  },
};

// Start a few blocks behind the head, so the first live chunk is not at the very tip
const HEAD_MARGIN = 5;

async function main() {
  const name = process.argv[2];
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`Usage: register-contract.ts <preset>; presets: ${Object.keys(PRESETS).join(', ')}`);
  }

  const network = await queryOne<{ id: string; chain_type: 'evm' | 'tron' | 'solana' }>(
    'SELECT id, chain_type FROM networks WHERE name = $1',
    [preset.network]
  );
  if (!network) throw new Error(`Network ${preset.network} not found`);

  // Same RPC endpoint as the network's other contracts
  const endpoint = await queryOne<{ id: string; url: string }>(
    `SELECT re.id, re.url FROM contracts c JOIN rpc_endpoints re ON re.id = c.rpc_endpoint_id
     WHERE c.network_id = $1 ORDER BY c.created_at LIMIT 1`,
    [network.id]
  );
  if (!endpoint) throw new Error(`No RPC endpoint in use on ${preset.network}; register one first`);

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM contracts WHERE network_id = $1 AND lower(contract_address) = lower($2)',
    [network.id, preset.address]
  );
  if (existing) {
    console.log(`${preset.coin.ticker} on ${preset.network} is already registered: ${existing.id}`);
    return;
  }

  const adapter = await createAdapter(network.chain_type, endpoint.url);
  let head: number;
  let creationDate: Date;
  let onChainDecimals: number;
  try {
    head = await adapter.getCurrentBlockNumber();
    creationDate = new Date((await adapter.getBlockTimestamp(preset.creationBlock)) * 1000);
    onChainDecimals = await adapter.getTokenDecimals(preset.address);
  } finally {
    await adapter.disconnect();
  }
  if (onChainDecimals !== preset.coin.decimals) {
    throw new Error(`${preset.coin.ticker} has ${onChainDecimals} decimals on chain, preset says ${preset.coin.decimals}`);
  }
  const startBlock = head - HEAD_MARGIN;

  const contractId = await transaction(async (client) => {
    const company = await client.query<{ id: string }>(
      `INSERT INTO companies (name, website) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [preset.company.name, preset.company.website]
    );
    const coin = await client.query<{ id: string }>(
      `INSERT INTO stablecoins (company_id, ticker, name, decimals) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, ticker) DO UPDATE SET ticker = EXCLUDED.ticker RETURNING id`,
      [company.rows[0].id, preset.coin.ticker, preset.coin.name, preset.coin.decimals]
    );
    const contract = await client.query<{ id: string }>(
      `INSERT INTO contracts (stablecoin_id, network_id, contract_address, rpc_endpoint, rpc_endpoint_id,
                              creation_block, creation_date, event_set, initial_supply, listed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false) RETURNING id`,
      [coin.rows[0].id, network.id, preset.address, endpoint.url, endpoint.id,
       preset.creationBlock, creationDate, preset.eventSet, preset.initialSupply]
    );
    await client.query(
      `INSERT INTO sync_state (contract_id, status, last_synced_block) VALUES ($1, 'synced', $2)`,
      [contract.rows[0].id, startBlock]
    );
    // Fees are known from where the live sync starts; backfill-receipt-fees fills in the rest
    await client.query(
      `INSERT INTO fee_backfill_state (contract_id, low_block, target_block, status) VALUES ($1, $2, $3, 'pending')`,
      [contract.rows[0].id, startBlock + 1, preset.creationBlock]
    );
    return contract.rows[0].id;
  });

  console.log(`Registered ${preset.coin.ticker} on ${preset.network}: ${contractId}`);
  console.log(`  live sync starts at block ${(startBlock + 1).toLocaleString()} (head ${head.toLocaleString()}); unlisted`);
  console.log(`Next: restart the indexer, wait for its first sync, then`);
  console.log(`  npm run backfill-events -- ${contractId} --full`);
  console.log(`and once that is complete`);
  console.log(`  npx ts-node src/indexer/backfill-receipt-fees.ts ${contractId}`);
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

export { PRESETS };
