import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../../db';
import { SyncState } from '../../types';
import { getIndexerQueue } from '../../indexer/queue';

const router = Router();

// Get overall sync status
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const stats = await query<{
      status: string;
      count: string;
    }>(
      `SELECT status, COUNT(*) as count
       FROM sync_state
       GROUP BY status`
    );

    const contracts = await query<{
      contract_id: string;
      stablecoin_ticker: string;
      network_name: string;
      status: string;
      last_synced_block: number;
      last_synced_at: Date | null;
      error_message: string | null;
    }>(
      `SELECT
         ss.contract_id,
         s.ticker as stablecoin_ticker,
         n.name as network_name,
         ss.status,
         ss.last_synced_block,
         ss.last_synced_at,
         ss.error_message
       FROM sync_state ss
       JOIN contracts ct ON ss.contract_id = ct.id
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       ORDER BY ss.status, s.ticker, n.name`
    );

    const statusCounts = stats.reduce((acc, { status, count }) => {
      acc[status] = parseInt(count);
      return acc;
    }, {} as Record<string, number>);

    res.json({
      summary: {
        total: contracts.length,
        ...statusCounts,
      },
      contracts,
    });
  } catch (error) {
    console.error('Error fetching sync status:', error);
    res.status(500).json({ error: 'Failed to fetch sync status' });
  }
});

// Get sync status for a specific contract
router.get('/status/:contractId', async (req: Request, res: Response) => {
  try {
    const syncState = await queryOne<SyncState & {
      stablecoin_ticker: string;
      network_name: string;
      creation_block: number | null;
      current_block?: number;
    }>(
      `SELECT
         ss.*,
         s.ticker as stablecoin_ticker,
         n.name as network_name,
         ct.creation_block
       FROM sync_state ss
       JOIN contracts ct ON ss.contract_id = ct.id
       JOIN stablecoins s ON ct.stablecoin_id = s.id
       JOIN networks n ON ct.network_id = n.id
       WHERE ss.contract_id = $1`,
      [req.params.contractId]
    );

    if (!syncState) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    // Calculate progress if we have creation block
    let progress: number | null = null;
    if (syncState.creation_block && syncState.last_synced_block) {
      // Note: We'd need to fetch current block from RPC for accurate progress
      // For now just return the last synced block
      progress = null;
    }

    res.json({
      ...syncState,
      progress,
    });
  } catch (error) {
    console.error('Error fetching sync status:', error);
    res.status(500).json({ error: 'Failed to fetch sync status' });
  }
});

// Manually trigger sync for a contract
router.post('/trigger/:contractId', async (req: Request, res: Response) => {
  try {
    // Verify contract exists
    const contract = await queryOne<{ id: string }>(
      'SELECT id FROM contracts WHERE id = $1',
      [req.params.contractId]
    );

    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    // Update sync state to pending
    await execute(
      `UPDATE sync_state
       SET status = 'pending', error_message = NULL, updated_at = NOW()
       WHERE contract_id = $1`,
      [req.params.contractId]
    );

    // Queue sync job
    try {
      const queue = getIndexerQueue();
      await queue.add('sync-contract', {
        contractId: req.params.contractId,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });

      res.json({ message: 'Sync triggered successfully' });
    } catch (queueError) {
      console.error('Failed to queue sync job:', queueError);
      res.status(500).json({ error: 'Failed to queue sync job. Is Redis running?' });
    }
  } catch (error) {
    console.error('Error triggering sync:', error);
    res.status(500).json({ error: 'Failed to trigger sync' });
  }
});

// Reset sync state (re-index from beginning)
router.post('/reset/:contractId', async (req: Request, res: Response) => {
  try {
    // Verify contract exists
    const contract = await queryOne<{ id: string }>(
      'SELECT id FROM contracts WHERE id = $1',
      [req.params.contractId]
    );

    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    // Reset sync state
    await execute(
      `UPDATE sync_state
       SET last_synced_block = 0,
           last_synced_at = NULL,
           status = 'pending',
           error_message = NULL,
           updated_at = NOW()
       WHERE contract_id = $1`,
      [req.params.contractId]
    );

    // Delete existing metrics
    await execute(
      'DELETE FROM metrics WHERE contract_id = $1',
      [req.params.contractId]
    );

    // Queue discovery job
    try {
      const queue = getIndexerQueue();
      await queue.add('discover-contract', {
        contractId: req.params.contractId,
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });

      res.json({ message: 'Sync reset and re-indexing triggered' });
    } catch (queueError) {
      console.error('Failed to queue job:', queueError);
      res.json({ message: 'Sync reset. Trigger sync manually or start indexer.' });
    }
  } catch (error) {
    console.error('Error resetting sync:', error);
    res.status(500).json({ error: 'Failed to reset sync' });
  }
});

export default router;
