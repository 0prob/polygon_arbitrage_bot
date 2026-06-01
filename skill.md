---
name: polygon-arb-bot
description: High-frequency, flash-loan-only arbitrage bot for DEXs on Polygon PoS (chain 137). Focuses on multi-hop cycles using Balancer V2 / Aave V3 flash loans executed atomically via ArbExecutor. Primary data sources: custom Envio HyperIndex for pool discovery + direct RPC multicalls for state. Heavy investment in simulation, mempool monitoring, execution resilience, and AI-assisted debugging tools.
license: Private
compatibility: Requires Bun, Node.js 20+, Foundry, Polygon RPC endpoints (archival preferred), Envio API tokens for HyperSync.
metadata:
  author: x/arb/t team
  version: "2026.06"
  docs: https://github.com/owner/arb/t (see AGENTS.md, README.md, docs/superpowers/)
---

# Polygon Arbitrage Bot

Flash-loan-only, high-frequency DEX arbitrage engine optimized for Polygon. All paths are atomic and capital-free on the executor side. The system combines:

- Custom Envio HyperIndex for efficient pool discovery and metadata.
- In-memory graph + ternary search simulator for cycle evaluation.
- Sophisticated RPC layer with failover, mempool watching, and trace analysis.
- TUI for live monitoring.
- Extensive AI tooling (custom skills, MCP configs, trace simulators) for rapid debugging and development.

---

## Capabilities

### Core Arbitrage Engine

**Discover and evaluate profitable cycles**
- Ingest pools via HyperIndex (new PairCreated/PoolCreated events).
- Build adjacency graph from on-chain + cached state.
- Enumerate 2/3/4-hop cycles.
- Simulate with real AMM math (Uniswap V2/V3, Curve stables/crypto, Balancer weighted, DODO PMM, WooFi).
- Use ternary search + profit assessment (always deducts flash loan fees).
- Only execute when `RouteSimulationResult.amountIn` exactly matches flash principal and profit exceeds threshold after all costs.

**Flash-loan-only execution (strict invariant)**
- All cycles go through `ArbExecutor` using Balancer V2 or Aave V3 flash loans.
- No inventory or pre-funded capital on the executor contract.
- Reverts cleanly on misuse (`FlashLoanRequired`, `FlashLoanOnly`).
- Calldata builders in `services/execution/calldata/`.

**Mempool and competing tx awareness**
- Real-time pending tx monitoring with coalescing.
- HyperSync trace parsing for flashloan detection, protocol fingerprinting, depth analysis, and suspicious patterns (sandwiches, JIT, etc.).
- Quarantine and risk scoring for execution.

### Data & Indexing Layer

**Envio HyperIndex (hyperindex/)**
- Dynamic contract registration for thousands of pools via factory events.
- Effect API for enriching creation events with token decimals and protocol metadata (RPC + local caches + persistence).
- Live-debug profile: minimal DB writes on hot paths; bot owns live state via RPC fetcher.
- Hot-bias filtering (`INDEXER_HOT_BIAS`) for focused discovery.
- See `hyperindex/config.yaml`, `src/handlers/`, `src/effects/`, and previous Envio doc reviews for patterns.

**Direct HyperSync client usage**
- High-performance reads, trace fetching, receipt reconstruction.
- Multi-token rotation and local rate limiting.
- Used for both indexing bootstrap and execution-time intelligence.

**State & Rates**
- `fetchMissingPoolState` (LF path + pre-fetch).
- `computeMaticRates` and price impact calculations.
- Token registry with static + discovered decimals.

### Development & Debugging Superpowers

**arb-tx-tools skill (primary AI debugging loop)**
- Transaction simulator (Anvil forks + Alchemy MCP `simulateExecution`/`traceCall`).
- ABICoder using exact project ABIs + custom errors.
- Log tailer for runtime TS errors, JSON-RPC limits, HyperIndex lag, etc.
- Typical loop: tailer → reproduce with simulator → decode revert → fix → verify.

**Other AI skills**
- Multiple indexer skills (schema, handlers, performance, traces, external calls, etc.).
- Graphify for codebase knowledge graphs.
- Context7 and MCP support already configured in the environment.

**Simulation & Testing**
- Foundry tests for ArbExecutor (atomic, Aave fork, auth).
- TS pipeline tests (graph, simulator, token registry).
- Pass loop tests with full dependency injection.

---

## Workflows

### Workflow: Debug a failing or low-profit arb path

1. Use `log-tailer --last 100 --errors-only` (or filter for the tx hash).
2. Reproduce exactly with `arb-tx-tools simulator` (Anvil fork or Alchemy `simulateExecution`).
3. Decode the revert using `abicoder decode-revert --data 0x...` against project ABIs.
4. Inspect trace with `simulate --to ... --data ...`.
5. Fix in calldata builder, math library, assessment, or execution service.
6. Re-run simulation and live pass (with TUI) to confirm.
7. Update relevant test or add regression case.

### Workflow: Add support for a new DEX / AMM

1. Add math simulator in `src/core/math/` (pure functions, matching on-chain behavior exactly).
2. Add protocol constants and calldata encoding in `src/services/execution/calldata/`.
3. Update `src/pipeline/simulator.ts` and `finder.ts` dispatch logic.
4. If new pool type: extend HyperIndex (new handlers/effects in `hyperindex/`, update schema if needed, run codegen).
5. Add hot tokens / garbage filters if appropriate.
6. Write unit tests for the new math module.
7. Test end-to-end with `arb_only` or full TUI run against real or forked state.
8. Update AGENTS.md and this skill.md with the new workflow details.

### Workflow: Modify or debug the HyperIndex layer

1. Work in `hyperindex/`.
2. Use dedicated indexer skills (schema, handlers, performance, external-calls, traces, etc.).
3. For dynamic contracts: follow `contractRegister` + `where` patterns (see previous Envio dynamic-contracts review).
4. For effects: use `createEffect` with proper input/output schemas, rate limits, and `cache: true`.
5. For preload optimization: schedule all effects early, guard sets with `context.isPreload`.
6. Run `cd hyperindex && pnpm codegen` after schema/config changes.
7. Test discovery with `bun run dev` in hyperindex or via the main bot's 60s poll.
8. Monitor pipeline split (Loaders/Handlers/DB Writes) and SLOW_EFFECT logs.

### Workflow: Add or improve AI tooling / skills for the project

1. Create or update files under `.grok/skills/` or `.claude/skills/`.
2. Follow the SKILL.md format used by existing tools (arb-tx-tools is the reference).
3. Update this `skill.md` and `AGENTS.md` to document the new capability.
4. Test the skill in the actual AI environment (Grok, Claude, Cursor).
5. For Polygon-specific knowledge, configure the official Polygon Docs MCP or Context7 (see below).

### Workflow: Onboard a new AI coding assistant to the project

1. Point the assistant at `AGENTS.md` (primary) + this `skill.md` + `llms.txt`.
2. Instruct it to use the `arb-tx-tools` skill for all on-chain debugging.
3. For Polygon chain details, have it use Context7 library `llmstxt/polygon_technology_llms_txt` or the Polygon Docs MCP.
4. Run `bun test` and typecheck early and often.
5. Respect hot-path rules (no sync I/O in 200ms loop, use RpcManager, etc.).

---

## Integration

**Key commands**
- `bun run src/cli/main.ts --tui`
- `bun run src/cli/arb_only.ts --tui`
- `bun test`
- `bun run typecheck`
- `cd hyperindex && pnpm dev` (or `bun run dev`)
- `arb-tx-tools` (the custom skill for simulation + decoding)

**Core technologies**
- TypeScript + Bun (runtime)
- viem + wagmi patterns (RPC)
- Foundry (Solidity contracts + tests)
- Envio HyperIndex + HyperSync client (indexing + traces)
- Pino logger, TUI (Ink/React)
- Extensive custom AI skills and MCP configuration

**Important invariants (never violate)**
- Flash-loan-only on executor (see `sol/src/ArbExecutor.sol` and AGENTS.md).
- All profit math deducts flash fees.
- Hot path (200ms): no sync I/O, use injected deps, respect frequency tiers.
- Use `RpcManager` for all RPC access.
- Prefer HyperSync + direct client over raw RPC where possible.

**Key addresses (Polygon mainnet)**
- See `src/config/addresses.ts`
- ArbExecutor (deployed)
- Balancer Vault, Aave V3 Pool, major DEX factories and routers

---

## Context & Architecture Notes

- **Flash-loan dependent by design**: No capital on executor. All value comes from atomic arbitrage.
- **Data split**: HyperIndex for discovery + bootstrap; bot's RPC fetcher + multicalls for hot live state.
- **AI-first development**: This project is heavily optimized for AI coding agents. Custom skills (especially arb-tx-tools), detailed AGENTS.md, and now this skill.md exist to make agents maximally effective.
- **Polygon-specific**: Chain ID 137. Heavy use of POL gas, WMATIC, USDC.e, etc. When in doubt about Polygon behavior, use official Polygon Docs via Context7 or MCP rather than guessing.

For the absolute latest architecture and rules, always start with `AGENTS.md`.

---

**Recommended for AI agents working in this repo**:
- Read `AGENTS.md` first.
- Read this `skill.md` for structured capabilities and workflows.
- Use `llms.txt` (if present) for broad document discovery.
- When Polygon chain or infrastructure questions arise, use Context7 with `llmstxt/polygon_technology_llms_txt` or the official Polygon Docs MCP server.
