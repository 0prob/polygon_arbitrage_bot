# Polygon Arb Bot

High-frequency, **strictly flash-loan-only** arbitrage bot for Polygon (chain 137). Every arb path is atomic via Balancer V2 or Aave V3 flash loan on the `ArbExecutor` contract. No capital-backed or inventory execution paths exist anywhere in the system (contract reverts with `FlashLoanRequired` / `FlashLoanOnly` on misuse).

- `RouteSimulationResult.amountIn` is always the exact flash principal borrowed.
- Profit assessment (`computeProfit`) always deducts the flash loan fee.
- See `sol/src/ArbExecutor.sol` and `src/core/assessment/profit.ts`.

## Features (current)

- Multi-protocol AMM math (V2/V3, Curve, Balancer, DODO, WooFi, V4 etc.)
- Real-time discovery via custom Envio HyperIndex (dynamic registration, effects for meta, hot-bias option)
- Hot path: 200ms HF (sim/execute) + 1s LF (state/rates) + 60s discovery
- Sophisticated resilience (circuits, reorg on slow path only, tier degrade, mempool signals)
- TUI + structured logs + extensive AI debugging tools (Anvil + ABI decoder + log tailer, with some shared modules between MCP and direct CLIs)
- All hot-path work is pure or gated; single sources for graph edges, rates, garbage, etc. (see recent DUPLICATION_AUDIT)

## Architecture (post cleanups)

Key points:

- `src/rpc/manager.ts` is the only way to get RPC clients.
- `src/pipeline/` owns graph/finder/sim/fetch/rates/eval (pure).
- `src/orchestrator/pass_loop.ts` is the multi-frequency orchestrator (loop.ts is now a tiny typed DI bag; old dead `runPipeline` extraction removed long ago).
- `src/services/execution/` is thin + calldata builders.
- No more `getPools` dangling, no tax wiring, no legacy strategy/ facade.
- Garbage/factories consolidated to `infra/garbage/garbage-tracker.ts` (re-exported via core/constants).
- Arb tx tools: some logic consolidated (direct .grok scripts now import AnvilManager, shared abi-registry, LogCapture).

```
src/
├── cli/main.ts + arb_only.ts
├── config/
├── rpc/manager.ts
├── pipeline/               # graph, finder (DFS), simulator (combined impact+sim), fetcher (returns updated), rates (incremental), ...
├── orchestrator/           # boot, pass_loop (HF/LF + dirty updates + single rates + budget), ...
├── services/execution/ + mempool/
├── infra/{hypersync,rpc,resilience,garbage,observability}
├── core/{math,assessment,types,utils,constants}
└── tui/
```

HyperIndex lives in `hyperindex/` (separate package, dynamic contracts + effect-first preload profile).

Sol: `sol/src/ArbExecutor.sol` (enforces flash only) + tests.

## AI Tooling

See the dedicated **AI Tooling, Skills, MCPs & lspmux** section below (and AGENTS.md + skill.md + llms.txt + .grok/skills/arb-tx-tools/SKILL.md for the full arb-tx-tools loop, consolidated modules, and how to use `/graphify`, Context7, Alchemy MCP sims, etc.).

## Prerequisites

- Bun >= 1.2
- Envio API token (for HyperIndex/HyperSync)
- Polygon RPC(s) — archival preferred for discovery
- Deployed ArbExecutor (flash-loan-only) + gas-funded key

## Supported Protocols

| Protocol                         | Math Engine     | Factory        |
| -------------------------------- | --------------- | -------------- |
| Uniswap V2 / Sushi V2 / Quick V2 | `uniswap_v2.ts` | Factory-based  |
| Uniswap V3 / Sushi V3 / Quick V3 | `uniswap_v3.ts` | Factory-based  |
| KyberSwap Elastic                | `uniswap_v3.ts` | Factory-based  |
| Curve StableSwap                 | `curve.ts`      | Registry-based |
| Balancer V2                      | `balancer.ts`   | Vault-based    |
| DODO vPMM                        | `dodo.ts`       | DVM/DPP/DSP    |
| WooFi SSLP                       | `woofi.ts`      | SSLP-based     |
| Uniswap V4                       | `uniswap_v4.ts` | PoolManager    |

## Quick Start

```bash
cp .env.example .env   # fill ENVIO_API_TOKEN, PRIVATE_KEY, EXECUTOR_ADDRESS, RPCs etc.
bun install
bun run check

bun run tui          # full bot + TUI (recommended)
# Arb-only (external HyperIndex): first `bun run dev` in another shell, then `bun run arbt`
```

## AI Tooling, Skills, MCPs & lspmux

This repo is heavily optimized for AI coding agents.

**Primary debug skill**: `arb-tx-tools`

- Direct: `bun .grok/skills/arb-tx-tools/scripts/{log-tailer.ts, simulator.ts, abicoder.ts}`
- MCP: registered as `arb-tx-tools` (see .opencode/opencode.json)
- Consolidated: direct scripts now import shared AnvilManager / buildAbiRegistry+decodeRevert / LogCapture from `scripts/arb-tx-tools/`
- Full loop + Alchemy MCP usage: see `.grok/skills/arb-tx-tools/SKILL.md`

**Other skills**:

- `.grok/skills/`: arb-tx-tools, create-skill, best-of-n, check-work, etc.
- `.claude/skills/`: full suite of Envio indexer skills (indexer-schema, indexer-handlers, indexer-performance, indexer-factory, indexer-traces, migrate-from-subgraph, ...) + graphify (`/graphify` any input → knowledge graph).
- Context7 for fresh library docs (resolve-library-id + query-docs).

**MCP servers** (in .opencode/opencode.json + connected):

- arb-tx-tools, sequential-thinking, fetch, memory, postgres (Hasura), envio_docs (remote)
- alchemy (EVM sim/trace/etc — use `search_tool` first then `use_tool`), coingecko, dexscreener, context7, grok_com_github, puppeteer, etc.

**lspmux**:

- Multiplexes language servers (TS, Solidity, GraphQL, YAML, Bash, JSON, TOML...) on 127.0.0.1:27631.
- Config: `lspmux/config.toml`; bins in `lspmux/bin/` proxy node_modules LSPs.
- Configure your AI editor/agent to point at the mux for consistent go-to-def / find-refs / hover / symbols across tools (avoids per-tool server duplication).

See AGENTS.md + skill.md + llms.txt for onboarding.

## Configuration

See `.env.example` (required first, then tuning) and `src/config/`.

No --cleanup (dummy removed long ago); real one-time garbage cleanup runs automatically via tracker.

## Scripts / Commands (current minimal set)

- `bun run tui` — full bot with TUI
- `bun run start` — full bot headless
- `bun run arb` / `bun run arbt` — arb-only (headless / TUI); pair with `bun run dev`
- `bun run dev` — HyperIndex standalone (with auto codegen + env)
- `bun run check` — tsc + eslint + prettier check (consolidated)
- `bun run fix` — eslint --fix + prettier --write
- Tests: `bunx vitest run` (direct; no "test" script in package.json)
- AI tools as above; HyperIndex inside: `cd hyperindex && bun run dev|codegen|dev:reset|...`

See AGENTS.md for invariants and full details.

## Solidity Contracts

Foundry project in `sol/`:

| Contract          | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `ArbExecutor.sol` | On-chain execution: flash loan → swap path → repay → profit |

## HyperIndex

The `hyperindex/` directory contains an Envio indexer that ingests events from Polygon factories, tracking pool discovery (and optionally state) in a Hasura-backed PostgreSQL instance.

See "Scripts / Commands" and the detailed dev notes in AGENTS.md / skill.md (or run `bun run dev` + `cd hyperindex && bun run dev:reset` for indexer work). The root wrapper (`scripts/dev-hyperindex.ts`) provides auto `codegen` and token updates.

## Tests

- Unit tests live next to source files (`src/**/*.test.ts`)
- Integration tests in `tests/` (TUI, hypersync)
- Solidity tests in `sol/test/` (Foundry)
- Property-based testing via `fast-check`
