# Polygon Arbitrage Bot

High-frequency, **strictly flash-loan-only** arbitrage bot for Polygon (chain 137). Every arbitrage path is atomic, using Balancer V2 or Aave V3 flash loans executed by the `ArbExecutor` contract. No capital-backed or inventory execution paths exist anywhere in the system; the contract enforces this by reverting with `FlashLoanRequired` / `FlashLoanOnly` if misused.

- `RouteSimulationResult.amountIn` is always the exact flash principal borrowed.
- Profit assessment (`computeProfit`) always deducts the flash loan fee.
- Core execution is implemented in pure Huff (`sol/src/ArbExecutor.huff`) for maximum gas efficiency.

## Features

- **Multi-protocol AMM math**: Exact profit calculations for Uniswap V2/V3, Algebra, KyberSwap Elastic, Curve StableSwap, Balancer V2, DODO vPMM, WooFi SSLP, and Uniswap V4.
- **Real-time Discovery**: Integrates with Envio HyperIndex for pool discovery, featuring dynamic pool registration and an optional hot-bias token filter.
- **Multi-frequency Architecture**:
  - **Hot Path**: ~200ms high-frequency execution loop (simulation, routing, calldata building, and mempool submittals).
  - **Medium/Low Path**: Rate fetching and state synchronization (1s interval).
  - **Discovery Path**: Dynamic pool index sync (60s interval).
- **Observability**: Real-time Terminal UI (TUI) dashboard, structured log files, and rich AI/CLI debugging tools.
- **Resilience**: Adaptive gas pricing, circuit breakers, RPC failure failover, and mempool competition detection.

## Directory Structure

```
.
├── src/
│   ├── cli/                # Entrypoints (main.ts, arb_only.ts)
│   ├── config/             # Configuration schemas (zod) and loaders
│   ├── rpc/                # RPC client management
│   ├── pipeline/           # pure core pipeline (graph builder, routing, simulators, fetchers)
│   ├── orchestrator/       # main loop and DI wiring
│   ├── services/
│   │   ├── execution/      # execution client, calldata builders, and track status
│   │   └── mempool/        # mempool decoder and websocket monitor
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

## Quick Start

1. **Configure Environment**:
   ```bash
   cp .env.example .env
   # Fill in PRIVATE_KEY, EXECUTOR_ADDRESS (see #3: Deploy Executor), ENVIO_API_TOKEN, and RPC URLs.
   ```
2. **Install Dependencies**:
   ```bash
   bun install
   ```
3. **Compile and Deploy Executor**:
   ```bash
   cd sol
   # Set RPC_URL, PRIVATE_KEY, and OWNER env vars, then run:
   ./deploy
   ```
4. **Run the Bot**:

   ```bash
   # Run the bot in full mode with Terminal UI:
   bun run tui

   # Or run headless:
   bun run start
   ```

## Scripts and CLI Commands

- `bun run tui` — Start the full bot with Terminal UI (TUI) dashboard.
- `bun run start` — Start the full bot in headless daemon mode.
- `bun run arb` / `bun run arbt` — Start execution-only (headless or TUI) using a running indexer.
- `bun run dev` — Standalone Envio HyperIndex runner (handles auto-codegen).
- `bun run fix` — Run linter fix and code formatter across the codebase.
- `bunx vitest run` — Run the TypeScript unit and integration test suite.
- `cd sol && forge test` — Run the Solidity contract unit tests.
