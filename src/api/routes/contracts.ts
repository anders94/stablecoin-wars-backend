import { Router, Request, Response } from 'express';
import { query, queryOne, execute, transaction } from '../../db';
import { Contract, SyncState, CreateContractRequest } from '../../types';
import { getIndexerQueue } from '../../indexer/queue';

const router = Router();

// List all contracts
router.get('/', async (_req: Request, res: Response) => {
  try {
    const contracts = await query<Contract & {
      stablecoin_ticker: string;
      stablecoin_name: string;
      network_name: string;
      network_display_name: string;
      sync_status: string;
    }>(
      `SELECT ct.*,
              s.ticker as stablecoin_ticker,
              s.name as stablecoin_name,
              n.name as network_name,
              n.display_name as network_display_name,
              ss.status as sync_status
       FROM contracts ct
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       LEFT JOIN sync_state ss ON ct.id = ss.contract_id
       ORDER BY s.ticker, n.name`
    );
    res.json(contracts);
  } catch (error) {
    console.error('Error fetching contracts:', error);
    res.status(500).json({ error: 'Failed to fetch contracts' });
  }
});

// Get contract by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const contract = await queryOne<Contract & {
      stablecoin_ticker: string;
      stablecoin_name: string;
      network_name: string;
      network_display_name: string;
      chain_type: string;
    }>(
      `SELECT ct.*,
              s.ticker as stablecoin_ticker,
              s.name as stablecoin_name,
              n.name as network_name,
              n.display_name as network_display_name,
              n.chain_type
       FROM contracts ct
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       WHERE ct.id = $1`,
      [req.params.id]
    );
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    res.json(contract);
  } catch (error) {
    console.error('Error fetching contract:', error);
    res.status(500).json({ error: 'Failed to fetch contract' });
  }
});

// Create contract (triggers indexing)
router.post('/', async (req: Request, res: Response) => {
  try {
    const { stablecoin_id, network_id, contract_address, rpc_endpoint } = req.body as CreateContractRequest;

    if (!stablecoin_id || !network_id || !contract_address || !rpc_endpoint) {
      return res.status(400).json({
        error: 'stablecoin_id, network_id, contract_address, and rpc_endpoint are required'
      });
    }

    const result = await transaction(async (client) => {
      // Create contract
      const contractResult = await client.query(
        `INSERT INTO contracts (stablecoin_id, network_id, contract_address, rpc_endpoint)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [stablecoin_id, network_id, contract_address, rpc_endpoint]
      );
      const contract = contractResult.rows[0] as Contract;

      // Create initial sync state
      await client.query(
        `INSERT INTO sync_state (contract_id, status)
         VALUES ($1, 'pending')`,
        [contract.id]
      );

      return contract;
    });

    // Queue the contract for indexing
    try {
      const queue = getIndexerQueue();
      await queue.add('discover-contract', {
        contractId: result.id,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } catch (queueError) {
      console.warn('Failed to queue indexing job:', queueError);
      // Don't fail the request, the contract was created
    }

    res.status(201).json(result);
  } catch (error: unknown) {
    console.error('Error creating contract:', error);
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Contract already exists on this network' });
    }
    if ((error as { code?: string }).code === '23503') {
      return res.status(400).json({ error: 'Invalid stablecoin_id or network_id' });
    }
    res.status(500).json({ error: 'Failed to create contract' });
  }
});

// Update contract
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { rpc_endpoint, is_active } = req.body;
    const contract = await queryOne<Contract>(
      `UPDATE contracts
       SET rpc_endpoint = COALESCE($1, rpc_endpoint),
           is_active = COALESCE($2, is_active)
       WHERE id = $3
       RETURNING *`,
      [rpc_endpoint, is_active, req.params.id]
    );
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    res.json(contract);
  } catch (error) {
    console.error('Error updating contract:', error);
    res.status(500).json({ error: 'Failed to update contract' });
  }
});

// Delete contract
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await transaction(async (client) => {
      // Delete sync state first
      await client.query('DELETE FROM sync_state WHERE contract_id = $1', [req.params.id]);
      // Delete metrics
      await client.query('DELETE FROM metrics WHERE contract_id = $1', [req.params.id]);
      // Delete contract
      const result = await client.query('DELETE FROM contracts WHERE id = $1', [req.params.id]);
      if (result.rowCount === 0) {
        throw new Error('not_found');
      }
    });
    res.status(204).send();
  } catch (error: unknown) {
    console.error('Error deleting contract:', error);
    if ((error as Error).message === 'not_found') {
      return res.status(404).json({ error: 'Contract not found' });
    }
    res.status(500).json({ error: 'Failed to delete contract' });
  }
});

// Get sync state for contract
router.get('/:id/sync', async (req: Request, res: Response) => {
  try {
    const syncState = await queryOne<SyncState>(
      'SELECT * FROM sync_state WHERE contract_id = $1',
      [req.params.id]
    );
    if (!syncState) {
      return res.status(404).json({ error: 'Sync state not found' });
    }
    res.json(syncState);
  } catch (error) {
    console.error('Error fetching sync state:', error);
    res.status(500).json({ error: 'Failed to fetch sync state' });
  }
});

export default router;
