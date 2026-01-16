import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../../db';
import { Stablecoin, Contract, CreateStablecoinRequest } from '../../types';

const router = Router();

// List all stablecoins
router.get('/', async (_req: Request, res: Response) => {
  try {
    const stablecoins = await query<Stablecoin & { company_name: string }>(
      `SELECT s.*, c.name as company_name
       FROM stablecoins s
       LEFT JOIN companies c ON s.company_id = c.id
       ORDER BY s.ticker`
    );
    res.json(stablecoins);
  } catch (error) {
    console.error('Error fetching stablecoins:', error);
    res.status(500).json({ error: 'Failed to fetch stablecoins' });
  }
});

// Get stablecoin by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const stablecoin = await queryOne<Stablecoin & { company_name: string }>(
      `SELECT s.*, c.name as company_name
       FROM stablecoins s
       LEFT JOIN companies c ON s.company_id = c.id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!stablecoin) {
      return res.status(404).json({ error: 'Stablecoin not found' });
    }
    res.json(stablecoin);
  } catch (error) {
    console.error('Error fetching stablecoin:', error);
    res.status(500).json({ error: 'Failed to fetch stablecoin' });
  }
});

// Get stablecoin by ticker
router.get('/ticker/:ticker', async (req: Request, res: Response) => {
  try {
    const stablecoin = await queryOne<Stablecoin & { company_name: string }>(
      `SELECT s.*, c.name as company_name
       FROM stablecoins s
       LEFT JOIN companies c ON s.company_id = c.id
       WHERE UPPER(s.ticker) = UPPER($1)`,
      [req.params.ticker]
    );
    if (!stablecoin) {
      return res.status(404).json({ error: 'Stablecoin not found' });
    }
    res.json(stablecoin);
  } catch (error) {
    console.error('Error fetching stablecoin:', error);
    res.status(500).json({ error: 'Failed to fetch stablecoin' });
  }
});

// Get contracts for a stablecoin
router.get('/:ticker/contracts', async (req: Request, res: Response) => {
  try {
    const contracts = await query<Contract & { network_name: string; network_display_name: string }>(
      `SELECT ct.*, n.name as network_name, n.display_name as network_display_name
       FROM contracts ct
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       WHERE UPPER(s.ticker) = UPPER($1)
       ORDER BY n.name`,
      [req.params.ticker]
    );
    res.json(contracts);
  } catch (error) {
    console.error('Error fetching contracts:', error);
    res.status(500).json({ error: 'Failed to fetch contracts' });
  }
});

// Create stablecoin
router.post('/', async (req: Request, res: Response) => {
  try {
    const { company_id, ticker, name, decimals } = req.body as CreateStablecoinRequest;

    if (!company_id || !ticker || !name) {
      return res.status(400).json({ error: 'company_id, ticker, and name are required' });
    }

    const stablecoin = await queryOne<Stablecoin>(
      `INSERT INTO stablecoins (company_id, ticker, name, decimals)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [company_id, ticker.toUpperCase(), name, decimals || 18]
    );
    res.status(201).json(stablecoin);
  } catch (error: unknown) {
    console.error('Error creating stablecoin:', error);
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Stablecoin already exists for this company' });
    }
    if ((error as { code?: string }).code === '23503') {
      return res.status(400).json({ error: 'Invalid company_id' });
    }
    res.status(500).json({ error: 'Failed to create stablecoin' });
  }
});

// Update stablecoin
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { ticker, name, decimals } = req.body;
    const stablecoin = await queryOne<Stablecoin>(
      `UPDATE stablecoins
       SET ticker = COALESCE($1, ticker),
           name = COALESCE($2, name),
           decimals = COALESCE($3, decimals)
       WHERE id = $4
       RETURNING *`,
      [ticker?.toUpperCase(), name, decimals, req.params.id]
    );
    if (!stablecoin) {
      return res.status(404).json({ error: 'Stablecoin not found' });
    }
    res.json(stablecoin);
  } catch (error) {
    console.error('Error updating stablecoin:', error);
    res.status(500).json({ error: 'Failed to update stablecoin' });
  }
});

// Delete stablecoin
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const count = await execute(
      'DELETE FROM stablecoins WHERE id = $1',
      [req.params.id]
    );
    if (count === 0) {
      return res.status(404).json({ error: 'Stablecoin not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting stablecoin:', error);
    res.status(500).json({ error: 'Failed to delete stablecoin' });
  }
});

export default router;
