# Polygon DEX Arbitrage Bot

Clean-room rewrite of a Polygon DEX arbitrage bot with Aave V3 flash loans, backrunning, and comprehensive test coverage.

## Architecture

### Core (`src/core/`)
- **Types**: Pool, Route, Execution, Protocol type definitions
- **Math**: 11 Solidity-ported math modules (Uniswap V2/V3, Balancer, Curve, Algebra)
- **Assessment**: Profit computation, risk assessment, optimizer, scorer
- **Utilities**: Identity, BigInt helpers, error types, concurrency, bounded priority queue

### Config (`src/config/`)
- Zod-validated schema with typed defaults
- Env/file-based loader with fail-fast startup

### Infrastructure (`src/infra/`)
- **RPC**: Endpoint pool with retry, client factory
- **HyperSync**: Client, stream, query builder
- **Database**: SQLite schema, pool/asset/history stores, checkpoints
- **Observability**: Pino structured logger, Prometheus metrics

### Services (`src/services/`)
- **Discovery**: Event decoders, pool enrichment, Curve factory queries
- **Strategy**: Routing graph, cycle finder, simulator, pipeline, backrunner, cache
- **Watcher**: Event streaming, state mutation, reorg handling, poll loop
- **Hydration**: Warmup, protocol-specific pollers, quiet pool sweep
- **Execution**: Gas oracle, nonce manager, calldata builder, flash loans, submission
- **Mempool**: Pending tx decoder, swap signal detection, coalescing

### Orchestrator (`src/orchestrator/`)
- Boot sequence, pass loop, circuit breaker, graceful shutdown

### CLI (`src/cli/`)
- Entry point, TUI live monitor

## Smart Contracts (`sol/`)

ArbExecutor.sol — flash loan receiver compatible with:
- Balancer (zero-fee flash loans)
- Aave V3 (5 bps premium)
- Uniswap V3 / SushiSwap V3 / QuickSwap V3 / Kyber Elastic DEX pools

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `POLYGON_RPC_URLS` | Comma-separated RPC endpoints | - |
| `EXECUTION_RPC_URL` | RPC for tx submission | - |
| `ENVIO_API_KEY` or `ENVIO_AI_API_KEY` | HyperSync API key | - |
| `LOG_LEVEL` | Logging level | `info` |
| `ETH_RPC_URL` | Foundry RPC for contract deploys | - |
| `PRIVATE_KEY` | Deployer/managed wallet key | - |
| `OWNER` | Contract owner address | - |

## Development

### Prerequisites
- Node.js 25+
- pnpm 11+
- Foundry (for Solidity contracts)

### Setup
```
git clone <repo>
pnpm install
```

### Testing
```
# All tests
pnpm test

# Specific test file
pnpm test -- src/core/math/uniswap_v2.test.ts

# Solidity tests
cd sol && forge test

# Benchmarks
npx vitest bench --run
```

### Deployment
```
# Contract deployment (requires ETH_RPC_URL + PRIVATE_KEY)
cd sol && ./d
```

## Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Core + Infrastructure | ✅ Complete |
| 2 | Services | ✅ Complete |
| 3 | Orchestrator + CLI | ✅ Complete |
| 4 | Backrunning + Circuit Breaker + Aave V3 | ✅ Complete |
| 5 | Smart Contracts | ✅ Complete |
| 6 | Optimization + Docs | ✅ Complete |
