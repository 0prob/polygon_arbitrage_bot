# Polygon Arb Bot

High-frequency arbitrage bot for Polygon (chain 137) with cross-chain support for Katana. Uses flash loans (Balancer V2 / Aave V3) to execute triangular and multi-hop arbitrage across 12+ DEX protocols.

## Features

- **Multi-protocol**: Uni V2/V3, Sushi V2/V3, QuickSwap V2/V3, Curve, Balancer, DODO, WooFi, KyberSwap, Uni V4
- **Flash loans**: Balancer V2 (BalancerPoolFlashRecipient) and Aave V3
- **Real-time state**: HyperIndex/Envio event indexer → Hasura → GraphQL pool state
- **Cross-chain arb**: Intent-based arbitrage between Polygon and Katana via AggLayer
- **TUI dashboard**: Terminal UI with live metrics, logs, and keybindings
- **Predictive cache**: Pre-computes profitable paths for faster pass-loop iterations

## Architecture

```
src/
├── cli/               Entry point (main.ts)
├── config/            Zod-validated env config loader, addresses, defaults
├── core/
│   ├── math/          AMM simulators: V2, V3, Curve, Balancer, DODO, WooFi
│   ├── assessment/    Profit & risk calculation
│   ├── types/         Pool, route, execution type definitions
│   └── utils/         BigInt helpers, error formatting
├── infra/
│   ├── hypersync/     HyperIndex GraphQL client + subprocess manager
│   ├── rpc/           Viem client factory with fallback, retry
│   └── observability/ Pino logger
├── orchestrator/      Boot, main pass loop, graceful shutdown
├── services/
│   ├── strategy/      Routing graph, cycle finder, simulation pipeline
│   ├── execution/     Calldata builder, gas oracle, nonce manager, submitter
│   ├── mempool/       Pending tx decoder, coalescing, signal emission
│   └── crosschain/    Price scanner, solver bot, order encoding
└── tui/               Terminal UI (event bus, layout, renderer, state)
```

### Main loop

```
Pool discovery → State refresh (GraphQL) → Graph rebuild (on pool change)
  → Cycle enumeration (2/3/4-hop) → Simulation + profit assessment
  → Candidate build → Gas estimation → Submission
```

Cross-chain scanner runs in parallel when enabled.

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
bun start                  # CLI mode
bun start:tui              # TUI dashboard
```

## Configuration

Environment variables are loaded via `src/config/loader.ts`, merged with built-in defaults (`src/config/defaults.ts`), and validated with Zod. See `.env.example` for every available option.

**Required vars**: `ENVIO_API_TOKEN`, `EXECUTION_RPC`, `GAS_ESTIMATION_RPC`, `EXECUTOR_ADDRESS`, `PRIVATE_KEY`.

### Testnet / dry-run

Set `DRY_RUN_BEFORE_SUBMIT=true` (default) to simulate without submitting.

## Scripts

```bash
bun run test              # Vitest
bun run typecheck         # tsc --noEmit
bun run lint              # ESLint
bun run fmt               # Prettier check
bun run fmt:fix           # Prettier write
bun run start             # Production run
bun run start:tui         # TUI mode
```

## Solidity Contracts

Foundry project in `sol/`:

| Contract | Purpose |
|----------|---------|
| `ArbExecutor.sol` | On-chain execution: flash loan → swap path → repay → profit |
| `KatanaExecutor.sol` | Cross-chain execution on Katana |
| `CrossChainIntentOrigin.sol` | UUPS escrow for cross-chain intents |

## HyperIndex

The `hyperindex/` directory contains an Envio indexer that ingests events from Polygon (and Katana) factories, tracking pool state in a Hasura-backed PostgreSQL instance served over GraphQL. The bot queries it for pool discovery and state refreshes.

## Cross-Chain Arbitrage (Polygon ↔ Katana)

When enabled, the bot scans for price discrepancies between Polygon and Katana pools. A solver posts escrow on Polygon (via `CrossChainIntentOrigin`), executes the arb on Katana, and claims the escrow via AggLayer proof.

## Tests

- Unit tests live next to source files (`src/**/*.test.ts`)
- Integration tests in `tests/` (TUI, orchestrator)
- Solidity tests in `sol/test/` (Foundry)
- Property-based testing via `fast-check`
