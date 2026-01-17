import express, { Request, Response, NextFunction } from 'express';
import companiesRouter from './routes/companies';
import stablecoinsRouter from './routes/stablecoins';
import networksRouter from './routes/networks';
import contractsRouter from './routes/contracts';
import metricsRouter from './routes/metrics';
import syncRouter from './routes/sync';
import rpcEndpointsRouter from './routes/rpcEndpoints';

const app = express();

app.use(express.json());

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/companies', companiesRouter);
app.use('/api/stablecoins', stablecoinsRouter);
app.use('/api/networks', networksRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/rpc-endpoints', rpcEndpointsRouter);

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('API Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

export default app;
