import dotenv from 'dotenv';
dotenv.config();

import app from './api';
import { closePool } from './db';

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Stablecoin Wars API running on port ${PORT}`);
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
