# Stablecoin Wars

A backend service for tracking and comparing stablecoin metrics across multiple blockchain networks. Track total supply, mints, burns, transactions, fees, and volume with support for flexible time-series aggregation.

## Features

- **Multi-chain support**: EVM chains (Ethereum, Polygon, Arbitrum, etc.), Tron, and Solana
- **Automatic indexing**: Add a contract and the system automatically discovers its creation block and indexes all historical data
- **Flexible time resolution**: Query metrics at daily granularity or zoom out to 10-day, 100-day, or 1000-day periods
- **Real-time sync**: Background worker continuously syncs new blocks
- **Comprehensive metrics**: Total supply, mints, burns, transaction count, unique addresses, transfer volume, and fees

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Database**: PostgreSQL with db-migrate
- **API**: Express.js REST API
- **Job Queue**: Bull (Redis-backed)
- **Blockchain Libraries**: ethers.js, tronweb, @solana/web3.js

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 6+

## Installation

```bash
# Clone the repository
git clone https://github.com/anders94/stablecoin-wars-backend.git
cd stablecoin-wars-backend

# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Edit .env with your database and Redis credentials
```

## Configuration

Edit `.env` with your settings:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=stablecoin_wars

# Redis (for Bull job queue)
REDIS_HOST=localhost
REDIS_PORT=6379

# API
PORT=3000
NODE_ENV=development
```

## Database Setup

```bash
# Create the database
createdb stablecoin_wars

# Run migrations
npm run migrate:up

# To rollback migrations
npm run migrate:down
```

## Running the Application

### Start the API Server

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

### Start the Indexer Worker

The indexer runs as a separate process and handles blockchain data fetching:

```bash
npm run indexer
```

## API Endpoints

### Companies

```
GET    /api/companies          # List all companies
POST   /api/companies          # Create company
GET    /api/companies/:id      # Get company by ID
PUT    /api/companies/:id      # Update company
DELETE /api/companies/:id      # Delete company
```

### Stablecoins

```
GET    /api/stablecoins                    # List all stablecoins
POST   /api/stablecoins                    # Create stablecoin
GET    /api/stablecoins/:id                # Get by ID
GET    /api/stablecoins/ticker/:ticker     # Get by ticker
GET    /api/stablecoins/:ticker/contracts  # Get contracts for ticker
PUT    /api/stablecoins/:id                # Update stablecoin
DELETE /api/stablecoins/:id                # Delete stablecoin
```

### Networks

```
GET    /api/networks              # List all networks
POST   /api/networks              # Create network
GET    /api/networks/:id          # Get by ID
GET    /api/networks/name/:name   # Get by name
PUT    /api/networks/:id          # Update network
DELETE /api/networks/:id          # Delete network
```

### Contracts

```
GET    /api/contracts          # List all contracts
POST   /api/contracts          # Create contract (triggers indexing)
GET    /api/contracts/:id      # Get by ID
GET    /api/contracts/:id/sync # Get sync state
PUT    /api/contracts/:id      # Update contract
DELETE /api/contracts/:id      # Delete contract
```

### Metrics

```
GET /api/metrics/:ticker
    Query params:
    - from: ISO date (required)
    - to: ISO date (required)
    - network: filter by network name (optional)
    - resolution: 86400 | 864000 | 8640000 | 86400000 | auto (optional)
    - metrics: comma-separated list (optional)

GET /api/metrics/:ticker/range  # Get available date range
```

### Sync Status

```
GET  /api/sync/status              # Overall sync status
GET  /api/sync/status/:contractId  # Per-contract status
POST /api/sync/trigger/:contractId # Manually trigger sync
POST /api/sync/reset/:contractId   # Reset and re-index
```

## Usage Examples

### Add a New Stablecoin

```bash
# 1. Create the company
curl -X POST http://localhost:3000/api/companies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Circle",
    "website": "https://circle.com"
  }'
# Response: {"id": "abc-123", "name": "Circle", ...}

# 2. Create the stablecoin
curl -X POST http://localhost:3000/api/stablecoins \
  -H "Content-Type: application/json" \
  -d '{
    "company_id": "abc-123",
    "ticker": "USDC",
    "name": "USD Coin",
    "decimals": 6
  }'
# Response: {"id": "def-456", "ticker": "USDC", ...}

# 3. Create the network (if not exists)
curl -X POST http://localhost:3000/api/networks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ethereum",
    "display_name": "Ethereum Mainnet",
    "chain_type": "evm",
    "chain_id": "1",
    "block_time_seconds": 12
  }'
# Response: {"id": "ghi-789", "name": "ethereum", ...}

# 4. Add the contract (auto-triggers indexing)
curl -X POST http://localhost:3000/api/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "stablecoin_id": "def-456",
    "network_id": "ghi-789",
    "contract_address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "rpc_endpoint": "https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY"
  }'
```

### Query Metrics

```bash
# Get daily metrics for USDC in January 2024
curl "http://localhost:3000/api/metrics/USDC?from=2024-01-01&to=2024-02-01"

# Get 10-day aggregated metrics for a full year
curl "http://localhost:3000/api/metrics/USDC?from=2024-01-01&to=2025-01-01&resolution=864000"

# Auto-select resolution based on date range
curl "http://localhost:3000/api/metrics/USDC?from=2020-01-01&to=2024-12-31&resolution=auto"

# Filter by network
curl "http://localhost:3000/api/metrics/USDC?from=2024-01-01&to=2024-02-01&network=ethereum"
```

### Check Sync Status

```bash
# Get overall status
curl http://localhost:3000/api/sync/status

# Trigger manual sync
curl -X POST http://localhost:3000/api/sync/trigger/{contract-id}
```

## Time Resolution

The system uses a powers-of-10 aggregation strategy based on daily metrics:

| Resolution | Seconds | Description |
|------------|---------|-------------|
| Daily | 86,400 | Base granularity |
| 10-day | 864,000 | ~1.5 weeks |
| 100-day | 8,640,000 | ~3 months |
| 1000-day | 86,400,000 | ~2.7 years |

Auto-resolution selection:
- Date range < 30 days → daily
- Date range 30-300 days → 10-day
- Date range 300-3000 days → 100-day
- Date range > 3000 days → 1000-day

## Database Schema

### Core Tables

- `companies` - Stablecoin issuers (Circle, Tether, etc.)
- `stablecoins` - Token definitions (USDC, USDT, etc.)
- `networks` - Blockchain networks (Ethereum, Polygon, Tron, etc.)
- `contracts` - Token deployments on networks
- `sync_state` - Indexing progress per contract

### Metrics Table

The `metrics` table stores aggregated data with:
- `contract_id` - Which contract
- `period_start` - Start of the time period
- `resolution_seconds` - Aggregation level
- `total_supply` - Supply at end of period
- `minted` / `burned` - Activity during period
- `tx_count` - Number of transfers
- `unique_senders` / `unique_receivers` - Unique addresses
- `total_transferred` - Volume in token units
- `total_fees_native` / `total_fees_usd` - Transaction fees

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Express API   │     │  Indexer Worker │
│   (port 3000)   │     │                 │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │                       │
    ┌────▼────┐             ┌────▼────┐
    │PostgreSQL│◄───────────│  Redis  │
    │          │            │ (Bull)  │
    └──────────┘            └─────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
              ┌─────▼─────┐ ┌────▼────┐ ┌─────▼─────┐
              │EVM Adapter│ │  Tron   │ │  Solana   │
              │ (ethers)  │ │(tronweb)│ │(@solana)  │
              └───────────┘ └─────────┘ └───────────┘
```

## Supported Networks

| Chain Type | Networks | Library |
|------------|----------|---------|
| EVM | Ethereum, Polygon, Arbitrum, Optimism, BSC, Avalanche, etc. | ethers.js |
| Tron | Tron Mainnet | tronweb |
| Solana | Solana Mainnet | @solana/web3.js |

## Development

```bash
# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Create a new migration
npm run migrate:create -- my-migration-name
```

## License

MIT
