# Polygon Arbitrage Bot

High-frequency, **strictly flash-loan-only** arbitrage bot for Polygon (chain 137). Every arbitrage path is atomic, using Balancer V2 or Aave V3 flash loans executed by the `ArbExecutor` contract. No capital-backed or inventory execution paths exist anywhere in the system; the contract enforces this by reverting with `FlashLoanRequired` / `FlashLoanOnly` if misused.

- `RouteSimulationResult.amountIn` is always the exact flash principal borrowed.
- Profit assessment (`computeProfit`) always deducts the flash loan fee.
- Core execution is implemented in pure Huff (`sol/src/ArbExecutor.huff`) for maximum gas efficiency.

## Features

- **Multi-protocol AMM math**: Exact profit calculations for Uniswap V2/V3, Algebra, KyberSwap Elastic, Curve StableSwap, Balancer V2, DODO vPMM, WooFi SSLP, and Uniswap V4.
- **V3/V4 tick-accurate simulation**: On-demand TickLens loading for cycle pools; shallow bounding when ticks are missing; QuoterV2 parity checks for drift detection.
- **Preflight consistency**: Mempool state overrides forwarded into dry-run (`eth_call` + `estimateGas` at `pending`); explicit gas limits from dry-run results; automatic stale-nonce recovery.
- **Real-time Discovery**: Integrates with Envio HyperIndex for pool discovery, featuring dynamic pool registration and an optional hot-bias token filter.
- **Multi-frequency Architecture**:
  - **Hot Path (HF)**: ~200ms loop — simulation, ranking, dry-run gate, execution.
  - **Low Path (LF)**: ~1s loop — unified GraphQL state merge → RPC gap-fill → tick fetch → rates → cycle enumeration (no separate 1s timer racing the pass loop).
  - **Discovery Path**: Dynamic pool index sync (60s interval).
  - **Head-driven refresh**: Targeted cycle-pool RPC refresh on each `newHead`.
- **Oracle-backed valuation**: Chainlink on-chain feeds (primary) + Pyth Hermes (fallback) with pool-graph divergence circuit breaker; replaces hardcoded MATIC/USD fallback.
- **MEV (optional)**: FastLane Atlas bundle submission for backruns (`pfl_addSearcherBundle`) with public-tx fallback; JIT/sandwich gated off by default.
- **Statistical ranking**: EV-based candidate sorting before dry-run; optional offline ML model (`RANKING_MODE=ml`).
- **Observability**: Real-time Terminal UI (TUI) dashboard, structured log files, NDJSON opportunity feature logging, and rich AI/CLI debugging tools.
- **Resilience**: Adaptive gas pricing, circuit breakers, RPC failure failover, reorg cache invalidation, and mempool competition detection.

## Directory Structure

```
.
├── src/
│   ├── cli/                # Entrypoints (main.ts, arb_only.ts)
│   ├── config/             # Configuration schemas (zod) and loaders
│   ├── rpc/                # RPC client management
│   ├── pipeline/           # Graph builder, routing, simulators, tick fetcher, V3 parity
│   ├── orchestrator/       # Pass loop (HF/LF), head refresh, boot wiring
│   ├── services/
│   │   ├── execution/      # Execution client, dry-run, calldata, gas, nonce recovery
│   │   ├── mempool/        # Decoder, pending overrides, state projection
│   │   ├── oracle/         # Chainlink + Pyth price oracle
│   │   ├── mev/            # FastLane relay + backrun bundle builder
│   │   └── ranking/        # Statistical EV scorer + optional ML model loader
│   ├── infra/              # Envio hypersync, resilience trackers, garbage collection, and observability
│   └── core/               # Math libraries (V2, V3, Balancer, etc.), types, constants, and utilities
├── sol/                    # Solidity / Foundry project
│   ├── src/                # Huff contract (ArbExecutor.huff) & Solidity reference (ArbExecutor.sol)
│   ├── script/             # Deployment script (ArbExecutor.s.sol)
│   └── test/               # Solidity unit tests & deployment bytecode wrapper (HuffDeployer.sol)
└── hyperindex/             # Standalone Envio HyperIndex package
```

## AI Tooling & Skills

This repository is optimized for development with AI coding agents:

- **`arb-tx-tools`**: Shared tools and scripts (`scripts/arb-tx-tools/`) for decoding reverts, simulating transactions on local Anvil forks, and tailing logs.
- **Envio Skills**: Located under `hyperindex/.claude/skills/` (handlers, schema, performance, subgraph migration, etc.).
- **`lspmux`**: Multiplexes language servers (TS, Solidity, GraphQL, YAML, Bash, JSON, TOML...) on `127.0.0.1:27631`. See `lspmux/config.toml` for editor integration.

## Prerequisites

- **Bun** >= 1.2
- **Envio API token** (for HyperIndex/HyperSync indexer)
- **Polygon RPCs** (archival nodes preferred for discovery)
- **Huff Compiler (`huffc`)** >= 0.3.2 (required to compile the executor contract)
- **Foundry / Forge** (for deploying and testing the contract)

## Supported Protocols

| Protocol                         | Math Engine     | Address Lookup / Factory |
| -------------------------------- | --------------- | ------------------------ |
| Uniswap V2 / Sushi V2 / Quick V2 | `uniswap_v2.ts` | Factory-based            |
| Uniswap V3 / Sushi V3 / Quick V3 | `uniswap_v3.ts` | Factory-based            |
| KyberSwap Elastic                | `uniswap_v3.ts` | Factory-based            |
| Curve StableSwap                 | `curve.ts`      | Registry-based           |
| Balancer V2                      | `balancer.ts`   | Vault-based              |
| DODO vPMM                        | `dodo.ts`       | DVM/DPP/DSP              |
| WooFi SSLP                       | `woofi.ts`      | SSLP-based               |
| Uniswap V4                       | `uniswap_v4.ts` | PoolManager              |

## Configuration

All bot settings are loaded from `.env` at the project root (see `src/config/loader.ts`). Values are validated with Zod (`src/config/schema.ts`); unset keys fall back to `src/config/defaults.ts`.

```bash
cp .env.example .env
```

**Required**

| Variable | Purpose |
| --- | --- |
| `PRIVATE_KEY` | Wallet key for signing txs (`0x` + 64 hex) |
| `EXECUTOR_ADDRESS` | Deployed `ArbExecutor` contract |
| `EXECUTION_RPC` | RPC for submission, receipts, and gas |

**Strongly recommended**

| Variable | Purpose |
| --- | --- |
| `ENVIO_API_TOKEN` | Envio token for HyperIndex / HyperSync |
| `POLYGON_RPC_URLS` | Comma-separated archival RPCs for discovery |
| `MEMPOOL_WEBSOCKET_URL` | Pending-tx WebSocket when mempool monitoring is on |

**Common tuning**

Routing (`ROUTING_*`, `CYCLE_REFRESH_INTERVAL_MS`, `LIQUIDITY_FLOOR_USD`, `V3_SHALLOW_MAX_IMPACT_BPS`, `TICK_*`), profit thresholds (`MIN_PROFIT_WEI`, `SLIPPAGE_BPS`, flash-loan settings), submission (`SUBMISSION_STRATEGY`, `PRIVATE_RELAY_URLS`), gas (`POLYGON_PRIORITY_FEE_*`, `GAS_POLL_INTERVAL_MS`), and risk controls (`QUARANTINE_*`, `ROI_SAFETY_CAP`).

**V3 accuracy & preflight**

| Variable | Default | Purpose |
| --- | --- | --- |
| `V3_SHALLOW_MAX_IMPACT_BPS` | `30` | Max impact for V3/V4 hops without loaded ticks |
| `TICK_FETCH_ENABLED` | `true` | Load TickLens data for cycle V3/V4 pools |
| `TICK_WORD_RANGE` | `3` | Bitmap word radius around active tick |
| `TICK_REFRESH_ON_MOVE` | `true` | Refetch when tick moves outside loaded range |

Dry-run uses mempool `stateOverride` at `blockTag: pending`. Gas limits are set from dry-run `gasUsed × 1.2`. Stale nonces are recovered automatically every ~5s.

**State sync**

| Variable | Default | Purpose |
| --- | --- | --- |
| `SYNC_HEAD_DRIVEN_REFRESH` | `true` | RPC refresh cycle pools on each new block head |
| `SYNC_HEAD_REFRESH_MAX_POOLS` | `50` | Cap pools refreshed per head event |

**Oracle**

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORACLE_ENABLED` | `true` | Chainlink + Pyth rate enrichment |
| `ORACLE_PYTH_HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes fallback URL |
| `ORACLE_MAX_DIVERGENCE_BPS` | `500` | Block token if oracle vs pool-graph diverges |

**MEV (FastLane Atlas)**

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEV_ENABLED` | `false` | Submit backrun bundles via FastLane |
| `MEV_FASTLANE_RELAY_URL` | FastLane Polygon relay | `pfl_addSearcherBundle` endpoint |
| `MEV_PUBLIC_BACKRUN_FALLBACK` | `true` | Normal public tx if bundle rejected |
| `MEV_JIT_ENABLED` | `false` | JIT liquidity (scaffold) |
| `MEV_SANDWICH_ENABLED` | `false` | Sandwich bundles (scaffold) |
| `MEV_MAX_BID_BPS` | `500` | Max bid vs expected profit |

Requires an on-chain solver implementing `ISolverContract.atlasSolverCall` (separate Solidity deploy).

**Ranking**

| Variable | Default | Purpose |
| --- | --- | --- |
| `RANKING_MODE` | `statistical` | `statistical` \| `ml` \| `off` |
| `RANKING_MODEL_PATH` | `data/ranking-model.json` | JSON model when `RANKING_MODE=ml` |

Opportunity features are logged to `{DATA_DIR}/opportunity-features.ndjson`.

**Indexer**

When running the full bot (`bun run start` / `bun run tui`), HyperIndex starts as a subprocess and reads root `.env` vars such as `HASURA_URL`, `HASURA_SECRET`, `HYPERSYNC_RPM_TARGET`, and optional `POLYGON_START_BLOCK`. Standalone indexer development uses `hyperindex/.env.example`.

See `.env.example` for the full list of supported variables with inline descriptions.

## Quick Start

1. **Configure environment**:
   ```bash
   cp .env.example .env
   # Set PRIVATE_KEY, EXECUTOR_ADDRESS, EXECUTION_RPC, ENVIO_API_TOKEN, and RPC URLs.
   ```
2. **Install dependencies**:
   ```bash
   bun install
   ```
3. **Compile and deploy executor**:
   ```bash
   cd sol
   RPC_URL=<your_rpc> PRIVATE_KEY=<your_key> ./deploy
   ```
4. **Run the bot**:
   ```bash
   bun run tui    # full bot with Terminal UI
   bun run start  # headless daemon
   ```

## Scripts and CLI Commands

- `bun run tui` — Start the full bot with Terminal UI (TUI) dashboard.
- `bun run start` — Start the full bot in headless daemon mode.
- `bun run arb` / `bun run arbt` — Start execution-only (headless or TUI) using a running indexer.
- `bun run dev` — Standalone Envio HyperIndex runner (handles auto-codegen).
- `bun run fix` — Run linter fix and code formatter across the codebase.
- `bunx vitest run` — Run the TypeScript unit and integration test suite.
- `cd sol && forge test` — Run the Solidity contract unit tests.
