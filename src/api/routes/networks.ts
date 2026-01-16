import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../../db';
import { Network, CreateNetworkRequest, ChainType } from '../../types';

const router = Router();

const VALID_CHAIN_TYPES: ChainType[] = ['evm', 'tron', 'solana'];

// List all networks
router.get('/', async (_req: Request, res: Response) => {
  try {
    const networks = await query<Network>(
      'SELECT * FROM networks ORDER BY display_name'
    );
    res.json(networks);
  } catch (error) {
    console.error('Error fetching networks:', error);
    res.status(500).json({ error: 'Failed to fetch networks' });
  }
});

// Get network by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const network = await queryOne<Network>(
      'SELECT * FROM networks WHERE id = $1',
      [req.params.id]
    );
    if (!network) {
      return res.status(404).json({ error: 'Network not found' });
    }
    res.json(network);
  } catch (error) {
    console.error('Error fetching network:', error);
    res.status(500).json({ error: 'Failed to fetch network' });
  }
});

// Get network by name
router.get('/name/:name', async (req: Request, res: Response) => {
  try {
    const network = await queryOne<Network>(
      'SELECT * FROM networks WHERE LOWER(name) = LOWER($1)',
      [req.params.name]
    );
    if (!network) {
      return res.status(404).json({ error: 'Network not found' });
    }
    res.json(network);
  } catch (error) {
    console.error('Error fetching network:', error);
    res.status(500).json({ error: 'Failed to fetch network' });
  }
});

// Create network
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, display_name, chain_type, chain_id, block_time_seconds } = req.body as CreateNetworkRequest;

    if (!name || !display_name || !chain_type) {
      return res.status(400).json({ error: 'name, display_name, and chain_type are required' });
    }

    if (!VALID_CHAIN_TYPES.includes(chain_type)) {
      return res.status(400).json({
        error: `Invalid chain_type. Must be one of: ${VALID_CHAIN_TYPES.join(', ')}`
      });
    }

    const network = await queryOne<Network>(
      `INSERT INTO networks (name, display_name, chain_type, chain_id, block_time_seconds)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.toLowerCase(), display_name, chain_type, chain_id || null, block_time_seconds || null]
    );
    res.status(201).json(network);
  } catch (error: unknown) {
    console.error('Error creating network:', error);
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Network already exists' });
    }
    res.status(500).json({ error: 'Failed to create network' });
  }
});

// Update network
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { name, display_name, chain_type, chain_id, block_time_seconds } = req.body;

    if (chain_type && !VALID_CHAIN_TYPES.includes(chain_type)) {
      return res.status(400).json({
        error: `Invalid chain_type. Must be one of: ${VALID_CHAIN_TYPES.join(', ')}`
      });
    }

    const network = await queryOne<Network>(
      `UPDATE networks
       SET name = COALESCE($1, name),
           display_name = COALESCE($2, display_name),
           chain_type = COALESCE($3, chain_type),
           chain_id = COALESCE($4, chain_id),
           block_time_seconds = COALESCE($5, block_time_seconds)
       WHERE id = $6
       RETURNING *`,
      [name?.toLowerCase(), display_name, chain_type, chain_id, block_time_seconds, req.params.id]
    );
    if (!network) {
      return res.status(404).json({ error: 'Network not found' });
    }
    res.json(network);
  } catch (error) {
    console.error('Error updating network:', error);
    res.status(500).json({ error: 'Failed to update network' });
  }
});

// Delete network
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const count = await execute(
      'DELETE FROM networks WHERE id = $1',
      [req.params.id]
    );
    if (count === 0) {
      return res.status(404).json({ error: 'Network not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting network:', error);
    res.status(500).json({ error: 'Failed to delete network' });
  }
});

export default router;
