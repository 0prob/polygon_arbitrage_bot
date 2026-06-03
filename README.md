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

## AI Superpowers

Primary: the arb-tx-tools skill.

- Direct (terminal): `bun .grok/skills/arb-tx-tools/scripts/log-tailer.ts --last 100 --errors-only`
  then `.../simulator.ts simulate ...` or start-fork
  then `.../abicoder.ts decode-revert --data 0x...`
- MCP (if registered via .opencode or your client): `bun run scripts/arb-tx-tools.ts`

Modules under scripts/arb-tx-tools/ are shared with the MCP server and were consolidated into the direct scripts.

See AGENTS.md + .grok/skills/arb-tx-tools/SKILL.md for the loop and exact incantations (including Alchemy MCP path via search_tool + use_tool).

## Quick Start (current)

```bash
cp .env.example .env   # fill required (ENVIO, PRIVATE_KEY, EXECUTOR, RPCs)
bun install
bun run check

bun run tui
# or arb-only (you run hyperindex externally): bun run src/cli/arb_only.ts --tui
```

See updated .env.example for all current options. No --cleanup flag anymore (dummy removed).

## More

- Full current commands and invariants: AGENTS.md
- llms.txt for AI assistants
- All changes audited for dead code, duplication, and single sources.

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

## Prerequisites

- Bun >= 1.2
- Envio API token (for HyperIndex/HyperSync)
- Polygon RPC(s) — archival preferred for discovery
- Deployed ArbExecutor (flash-loan-only) + gas-funded key

## Quick Start

```bash
cp .env.example .env
# Edit (see .env.example for current vars)
bun install
bun run check

bun run tui
# Arb-only mode (external indexer): bun run src/cli/arb_only.ts --tui
```

## AI Debugging

See AGENTS.md and the arb-tx-tools skill. Direct scripts live under `.grok/skills/arb-tx-tools/scripts/`. Some logic shared/consolidated with `scripts/arb-tx-tools/`.

## Configuration

See the rewritten `.env.example` (top section has required + common; full details in src/config/* ).

No legacy cleanup script or --cleanup (removed as dummy).

See `.env.example` (updated) and `src/config/` for the current set of variables. DRY_RUN_BEFORE_SUBMIT and --cleanup are gone (cleanup was dummy; dry runner is always available via ctx).

## Scripts / Commands

See AGENTS.md for the current list (bun run start / tui / hyperindex, check/fix, and the arb-tx-tools direct CLIs under .grok/skills/).

## For AI Assistants & Agents

This repo is heavily optimized for AI agents (custom skills + MCP + detailed context files).

See AGENTS.md + skill.md + updated llms.txt for the current state, commands, and arb-tx-tools usage (direct CLIs + consolidated shared modules).

## Running HyperIndex

`bun run hyperindex` (from root) — runs the indexer by itself (normal dev mode, via wrapper for ENVIO_API_TOKEN etc.).

For development on the indexer itself (after changing schema.graphql, config.yaml, handlers, or start_block):
- `cd hyperindex && bun run dev:reset`
  - Internally: runs `clear-hasura` (clears Hasura metadata to prevent "tables already tracked" warnings from Envio's effects) or warns, then `envio dev -r` (full reset/rebuild).
- `envio dev -r` (or `bun run dev -r` inside hyperindex) alone: does the reset but may leave metadata warnings if effects have created tables.
- `clear-hasura`: standalone metadata clear (usually not needed by itself; see the dev:reset for the benefit).
- `codegen`: regenerate Envio types after schema/config changes. **Now largely automatic**: the HyperIndex wrapper (used by both `bun run hyperindex` and the main bot) detects if schema.graphql or config.yaml is newer than .envio/types.d.ts and runs `envio codegen` for you before starting. No more forgetting the manual step. (The hyperindex internal `codegen` script remains for explicit runs.)
- Token generation (generate-tokens / generate-tokens:auto): largely automatic now. The bot's HyperIndex process wrapper calls the auto version on shutdown to self-update the static registry with newly discovered cold tokens (from effects during run). No more manual `gentok` or root gentok scripts. The generator scripts remain inside hyperindex/ for the auto mechanism and manual full regen if wanted.

See `hyperindex/package.json` and `hyperindex/scripts/` for the full list.

## Solidity Contracts

Foundry project in `sol/`:

| Contract          | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `ArbExecutor.sol` | On-chain execution: flash loan → swap path → repay → profit |

## HyperIndex

The `hyperindex/` directory contains an Envio indexer that ingests events from Polygon factories, tracking pool discovery (and optionally state) in a Hasura-backed PostgreSQL instance.

See the **"Working with the Indexer"** section above for the recommended development workflow (`dev` vs `dev:reset`).

## Tests

- Unit tests live next to source files (`src/**/*.test.ts`)
- Integration tests in `tests/` (TUI, hypersync)
- Solidity tests in `sol/test/` (Foundry)
- Property-based testing via `fast-check`
