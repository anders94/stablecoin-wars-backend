import dotenv from 'dotenv';
dotenv.config();

import app from './api';
import { closePool } from './db';

const PORT = Number(process.env.PORT || 3000);
// Only listen locally by default: the API includes write endpoints (contracts, sync resets)
const HOST = process.env.HOST || '127.0.0.1';

const server = app.listen(PORT, HOST, () => {
  console.log(`Stablecoin Wars API running on ${HOST}:${PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down...');
  server.close(async () => {
    await closePool();
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
