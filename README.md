# Polygon Arb Bot

High-frequency arbitrage bot for Polygon (chain 137). **Strictly flash-loan dependent** for all arbitrage: the `ArbExecutor` contract (Balancer V2 + Aave V3 flash paths) performs atomic borrow → multi-hop swaps → repay + profit extraction. No capital-backed or wallet-funded execution paths exist in the architecture or contracts.

- Simulation `amountIn` values are the precise flash principal sizes.
- Profit math always deducts the configured flash fee (0 bps Balancer, 5 bps Aave on Polygon).
- On-chain: `executeArb` / `executeArbWithAave` both require `flashAmount > 0` and enforce flash-only callbacks (`FlashLoanRequired`, `FlashLoanOnly` errors).

## Features

- **Multi-protocol**: Uni V2/V3, Sushi V2/V3, QuickSwap V2/V3, Curve, Balancer, DODO, WooFi, KyberSwap, Uni V4
- **Flash loans**: Balancer V2 (BalancerPoolFlashRecipient) and Aave V3
- **Real-time state**: HyperIndex/Envio event indexer → Hasura → GraphQL pool state
- **TUI dashboard**: Terminal UI with live metrics, logs, and keybindings
- **Multi-frequency loop**: Fast (200ms) cycles for simulation/execution, slow (1s) cycles for state refresh, discovery (60s) for new pools

## Architecture

```
src/
├── cli/                  Entry point (main.ts) — config → boot → runner → TUI
├── config/               Zod-validated env config loader, addresses, defaults
├── rpc/manager.ts        RpcManager — single class for all RPC access (read, execution, FastLane, WebSocket)
├── pipeline/             9 files — explicit pipeline stages (graph, finder, simulator, fetcher, rates, pipeline, instrumenter)
├── orchestrator/
│   ├── boot.ts           ~300L — wires RuntimeContext, starts HyperIndex, RPC, services
│   ├── pass_loop.ts      ~600L — main loop with multi-frequency timing + metrics wrapper
│   ├── loop.ts           Pipeline type definitions + runPipeline orchestrator
│   ├── runner.ts          PassRunner wrapper
│   └── shutdown.ts       Cleanup
├── services/
│   ├── execution/        ExecutionService (thin facade), SubmissionStrategy, ReceiptPoller, GasOracle, NonceManager, QuarantineManager, ExecutionTracker, DryRunner, Calldata builders
│   └── mempool/          Pending tx watching (coalescing, signal emission)
├── infra/
│   ├── hypersync/        HyperIndex/Envio subprocess manager + GraphQL queries
│   ├── rpc/              Client factory, WebSocket subscriptions
│   ├── resilience/       Circuit breakers, reorg detector, hyperindex monitor
│   └── observability/    Logger (Pino), health server
├── core/
│   ├── math/             AMM simulators: V2, V3, Curve, Balancer, DODO, WooFi
│   ├── assessment/       Profit & risk calculation
│   ├── types/            Pool, route, execution type definitions
│   └── utils/            BigInt helpers, error formatting
└── tui/                  Terminal UI (event bus, layout, renderer, state)
```

### Pipeline Flow (5 stages)

```
Discovery       →   GraphQL: new pools + state refresh
Enumeration     →   Build graph → Find cycles (2/3/4-hop)
Simulation      →   Ternary search → Evaluate amount → Profit assessment
Candidate Build →   Calldata → Dry-run → Gas estimation
Execution       →   Group compatible → Submit → Track confirmations
```

Multi-frequency timing:
- **HF (200ms)**: Simulation + execution for current cycle set
- **LF (1s)**: State refresh via RPC, rate recalculation, graph rebuild
- **Discovery (60s)**: Poll HyperIndex for new pools

## Supported Protocols

| Protocol | Math Engine | Factory |
|----------|-------------|---------|
| Uniswap V2 / Sushi V2 / Quick V2 | `uniswap_v2.ts` | Factory-based |
| Uniswap V3 / Sushi V3 / Quick V3 | `uniswap_v3.ts` | Factory-based |
| KyberSwap Elastic | `uniswap_v3.ts` | Factory-based |
| Curve StableSwap | `curve.ts` | Registry-based |
| Balancer V2 | `balancer.ts` | Vault-based |
| DODO vPMM | `dodo.ts` | DVM/DPP/DSP |
| WooFi SSLP | `woofi.ts` | SSLP-based |
| Uniswap V4 | `uniswap_v4.ts` | PoolManager |

## Prerequisites

- **Bun** >=1.2.0
- **Envio API token** (free at https://envio.dev/app)
- **Polygon RPC URLs** (Alchemy, QuickNode, or public)
- **Deployed ArbExecutor contract** on Polygon
- **Funded private key** for submission

## Quick Start

```bash
git clone <repo> && cd polygon-arb-bot
cp .env.example .env
# Edit .env — all required vars must be set
bun install

# Run the bot
bun run start              # Headless
bun run tui                # With Terminal UI
```

## Configuration

Environment variables are loaded via `src/config/loader.ts`, merged with built-in defaults (`src/config/defaults.ts`), and validated with Zod. See `.env.example` for every available option.

**Required vars**: `ENVIO_API_TOKEN`, `EXECUTION_RPC`, `GAS_ESTIMATION_RPC`, `EXECUTOR_ADDRESS`, `PRIVATE_KEY`.

### Testnet / dry-run

Set `DRY_RUN_BEFORE_SUBMIT=true` (default) to simulate without submitting.

## Scripts

```bash
# Main bot
bun run start             # Run the bot (headless)
bun run tui               # Run the bot with Terminal UI

# Development & testing
bun run test              # Run all tests
bun run typecheck         # TypeScript type checking
bun run lint              # Lint + auto-fix
bun run fmt               # Format code

# HyperIndex (Envio) development
bun run dev               # Start the indexer (development mode)
bun run dev:reset         # Kills port (respects ENVIO_INDEXER_PORT) + full reset (recommended for schema/start_block/handler changes)
bun run dev:kill          # Kill any process holding the default Envio indexer port (9898)
bun run cgen              # Regenerate Envio types after schema/config changes
bun run gentok            # Regenerate the static token decimals registry
bun run clear-hasura      # Clear Hasura metadata
```

### Working with the Indexer

The `hyperindex/` folder contains an Envio indexer.

**Common workflow:**

```bash
# When actively changing config.yaml, schema, handlers, or start_block:
bun run dev:reset

# For quick restarts (when nothing structural changed):
bun run dev
```

`bun run dev:reset` now automatically:
1. Runs `dev:kill` (respects `ENVIO_INDEXER_PORT` if set)
2. Performs a full reset (`envio dev -r` + Hasura metadata clear)

This is currently the safest and most reliable command when actively developing the indexer.

**Port conflicts (very common)**

If you see `Port 9898 is already in use`, you can still run:

```bash
bun run dev:kill
# or manually:
lsof -ti :9898 | xargs kill -9
```

You can also run the indexer on a different port:

```bash
ENVIO_INDEXER_PORT=9899 bun run dev
```

The `dev:reset` command is strongly recommended whenever you change `start_block`, the GraphQL schema, or handler logic. It performs a clean reset of both the indexer storage and Hasura metadata.

## Solidity Contracts

Foundry project in `sol/`:

| Contract | Purpose |
|----------|---------|
| `ArbExecutor.sol` | On-chain execution: flash loan → swap path → repay → profit |

## HyperIndex

The `hyperindex/` directory contains an Envio indexer that ingests events from Polygon factories, tracking pool discovery (and optionally state) in a Hasura-backed PostgreSQL instance.

See the **"Working with the Indexer"** section above for the recommended development workflow (`dev` vs `dev:reset`).

## Tests

- Unit tests live next to source files (`src/**/*.test.ts`)
- Integration tests in `tests/` (TUI, hypersync)
- Solidity tests in `sol/test/` (Foundry)
- Property-based testing via `fast-check`
