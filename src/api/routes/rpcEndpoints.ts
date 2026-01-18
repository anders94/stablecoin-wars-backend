import { Router, Request, Response } from 'express';
import { pool } from '../../db';
import { CreateRpcEndpointRequest, UpdateRpcEndpointRequest } from '../../types';

const router = Router();

/**
 * GET /api/rpc-endpoints - List all RPC endpoints
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT * FROM rpc_endpoints
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error listing RPC endpoints:', error);
    res.status(500).json({ error: 'Failed to list RPC endpoints' });
  }
});

/**
 * GET /api/rpc-endpoints/:id - Get a specific RPC endpoint
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM rpc_endpoints
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RPC endpoint not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching RPC endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch RPC endpoint' });
  }
});

/**
 * POST /api/rpc-endpoints - Create new RPC endpoint
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { url, max_requests_per_second, max_blocks_per_query, description } = req.body as CreateRpcEndpointRequest;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const result = await pool.query(`
      INSERT INTO rpc_endpoints (url, max_requests_per_second, max_blocks_per_query, description)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [url, max_requests_per_second || 10, max_blocks_per_query || 2000, description || null]);

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error('Error creating RPC endpoint:', error);
    if (error.code === '23505') {
      // Unique constraint violation
      return res.status(409).json({ error: 'RPC endpoint URL already exists' });
    }
    res.status(500).json({ error: 'Failed to create RPC endpoint' });
  }
});

/**
 * PATCH /api/rpc-endpoints/:id - Update RPC endpoint
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { max_requests_per_second, max_blocks_per_query, is_active, description } = req.body as UpdateRpcEndpointRequest;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (max_requests_per_second !== undefined) {
      updates.push(`max_requests_per_second = $${paramIndex++}`);
      values.push(max_requests_per_second);
    }
    if (max_blocks_per_query !== undefined) {
      updates.push(`max_blocks_per_query = $${paramIndex++}`);
      values.push(max_blocks_per_query);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(is_active);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(`
      UPDATE rpc_endpoints
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RPC endpoint not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating RPC endpoint:', error);
    res.status(500).json({ error: 'Failed to update RPC endpoint' });
  }
});

/**
 * DELETE /api/rpc-endpoints/:id - Delete RPC endpoint (soft delete by setting is_active to false)
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if any active contracts are using this endpoint
    const contractsCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM contracts
      WHERE rpc_endpoint_id = $1 AND is_active = true
    `, [id]);

    if (parseInt(contractsCount.rows[0].count) > 0) {
      return res.status(409).json({
        error: 'Cannot delete RPC endpoint that is being used by active contracts',
        contracts_using: contractsCount.rows[0].count
      });
    }

    // Soft delete by setting is_active to false
    const result = await pool.query(`
      UPDATE rpc_endpoints
      SET is_active = false, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RPC endpoint not found' });
    }

    res.json({ message: 'RPC endpoint deleted successfully' });
  } catch (error) {
    console.error('Error deleting RPC endpoint:', error);
    res.status(500).json({ error: 'Failed to delete RPC endpoint' });
  }
});

/**
 * GET /api/rpc-endpoints/:id/stats - Get usage statistics for an RPC endpoint
 */
router.get('/:id/stats', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get endpoint details
    const endpointResult = await pool.query(`
      SELECT * FROM rpc_endpoints WHERE id = $1
    `, [id]);

    if (endpointResult.rows.length === 0) {
      return res.status(404).json({ error: 'RPC endpoint not found' });
    }

    // Count contracts using this endpoint
    const contractsResult = await pool.query(`
      SELECT
        COUNT(*) as total_contracts,
        COUNT(*) FILTER (WHERE is_active = true) as active_contracts
      FROM contracts
      WHERE rpc_endpoint_id = $1
    `, [id]);

    // Get sync state statistics
    const syncStatsResult = await pool.query(`
      SELECT
        ss.status,
        COUNT(*) as count
      FROM sync_state ss
      JOIN contracts c ON ss.contract_id = c.id
      WHERE c.rpc_endpoint_id = $1
      GROUP BY ss.status
    `, [id]);

    const syncStats = syncStatsResult.rows.reduce((acc: any, row: any) => {
      acc[row.status] = parseInt(row.count);
      return acc;
    }, {});

    res.json({
      endpoint: endpointResult.rows[0],
      total_contracts: parseInt(contractsResult.rows[0].total_contracts),
      active_contracts: parseInt(contractsResult.rows[0].active_contracts),
      sync_stats: syncStats,
    });
  } catch (error) {
    console.error('Error fetching RPC endpoint stats:', error);
    res.status(500).json({ error: 'Failed to fetch RPC endpoint stats' });
  }
});

export default router;
