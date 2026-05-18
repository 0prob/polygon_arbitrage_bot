# Clean-Room Rewrite: Polygon Arbitrage Bot

**Date:** 2026-05-18
**Status:** Design Approved
**Approach:** Clean-room rewrite with preservation of battle-tested math and algorithms
**Estimated Effort:** 10-12 weeks

---

## 1. Problem Statement

The current codebase (`polygon-hypersync-discovery` v2.0.0) is a functional Polygon DEX arbitrage bot with excellent protocol coverage and sophisticated routing algorithms. However, it suffers from:

### Bugs
- **Gas unit mismatch (P0):** `gasCost` in MATIC wei is compared against `minNetProfit` in start-token units in `src/arb/profit_compute.ts`. This causes the bot to either reject profitable opportunities (when the start token is worth less than MATIC) or accept unprofitable ones (when worth more).
- **40 empty catch blocks** across the codebase silently swallow errors that may mask operational issues.

### Structural Issues
- **God module:** `src/app/runner.ts` (2916 lines) wires the entire application. Any change risks breaking unrelated functionality.
- **God class:** `RegistryService` facades 5 sub-stores through 16 DB files with redundant indirection layers (store class -> function module pattern adds no value).
- **Type duplication:** `LogLevel`, `LoggerFn`, `PoolState`, `FeeSnapshot` etc. are redeclared locally in 10+ files each to avoid circular deps.
- **Inconsistent logging:** 30+ raw `console.*` calls alongside a structured Pino logger.
- **20+ watcher files** with excessive decomposition (65-line files for single functions).

### Dead Code
- `src/utils/validation_job.ts` -- zero importers
- `src/utils/multicall.ts` -- zero importers (superseded by `enrichment/rpc.ts`)
- `src/state/pool_record.ts` -- 13-line re-export shim
- `src/routing/worker.ts` -- legacy one-shot worker
- `src/protocols/contract_catalog.ts` -- reference artifact, never used at runtime
- 28 exported symbols with zero consumers within `src/`

### Missing Capabilities
- **No Aave V3 flash loans:** Only Balancer (zero-fee on Polygon). Some tokens are only available via Aave.
- **No backrunning:** Mempool watcher detects pending swaps but only refreshes state -- doesn't construct arb opportunities from price dislocations.
- **No tests:** Zero test files. No property-based tests for critical financial math. No regression protection.
- **No circuit breaker:** No protection against sustained loss streaks.

### Configuration
- 745-line config file with 100+ untyped exports from `process.env`
- No validation at startup -- bad config discovered at runtime
- Hardcoded Alchemy API key in deployment script `sol/d`

---

## 2. Design Principles

1. **Domain Core has zero infrastructure dependencies.** Math, types, profit assessment, and pricing logic are pure functions. No RPC calls, no DB access, no logging side effects.
2. **Services own their lifecycle.** Each service manages its own state and exposes a clean async interface.
3. **Orchestrator composes services.** A ~200-line coordinator replaces the 2916-line `runner.ts`.
4. **Infrastructure is injected.** RPC clients, DB connections, and loggers are passed in, not imported as singletons.
5. **Preserve battle-tested code.** Math modules, routing algorithms, protocol definitions, and the Solidity contract are ported as-is. These are correct and any rewrite risks introducing rounding errors.
6. **Tests for financial paths.** All math, profit assessment, calldata encoding, and execution logic must have tests before being considered complete.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLI / Runner                       │
│  (process lifecycle, signal handling, TUI)            │
│  src/cli/                                            │
├─────────────────────────────────────────────────────┤
│                  Orchestrator                         │
│  (boot sequence, pass loop, shutdown)                 │
│  src/orchestrator/                                    │
├──────────┬──────────┬──────────┬────────────────────┤
│ Discovery│ Watcher  │ Strategy │  Execution          │
│ Service  │ Service  │ Engine   │  Service            │
│          │          │          │                      │
│          │ Mempool  │          │                      │
│          │ Service  │          │                      │
│  src/services/                                       │
├──────────┴──────────┴──────────┴────────────────────┤
│                 Domain Core                           │
│  (math, types, assessment, pricing)                   │
│  src/core/                                            │
├─────────────────────────────────────────────────────┤
│                Infrastructure                         │
│  (RPC, HyperSync, DB, metrics, logging)               │
│  src/infra/                                           │
└─────────────────────────────────────────────────────┘
```

**Dependency rule:** Each layer may only depend on layers below it. Never upward.

---

## 4. Infrastructure Layer (`src/infra/`)

### 4.1 RPC (`src/infra/rpc/`)

**Files:**
- `endpoint_pool.ts` -- Latency-scored endpoint pool with health tracking. Tracks per-endpoint: latency EMA, error rate, rate-limit state, method capabilities. No viem dependency -- pure data structure.
- `client_factory.ts` -- Single factory for all viem `PublicClient` and `WalletClient` instances. Standardized configuration: JSON-RPC batching enabled (wait: 16ms, size: 100), HTTP keep-alive, configurable timeout. Named client roles: `read`, `execute`, `gasEstimation`, `mempool` (WebSocket).
- `retry.ts` -- Generic RPC retry utility. Exponential backoff with jitter. Error classification: transient (network, 429, 503) vs permanent (invalid params, execution reverted). Configurable max retries and ceiling.

**Replaces:** `src/utils/rpc_manager.ts` (555 lines), `src/config/rpc_env.ts` (136 lines), inline client creation throughout.

### 4.2 HyperSync (`src/infra/hypersync/`)

**Files:**
- `client.ts` -- Singleton HyperSync client factory. Configuration from env vars. Graceful fallback when unavailable. Error differentiation: transport errors trigger cooldown, EVM reverts do not.
- `stream.ts` -- Streaming log fetcher using `client.stream()` with `concurrency: 10, batchSize: 1000`. Backpressure-aware. Replaces paginated polling.
- `query.ts` -- Query builder. Merges current `query_policy.ts` + `topics.ts`. Handles field selection, batch size, block limits, topic0 generation via viem.
- `types.ts` -- `HyperSyncLog`, `NormalizedLogMeta`, normalization functions. Preserve dedup/sort logic from current `logs.ts`.

**Replaces:** `src/hypersync/` (6 files).

### 4.3 Database (`src/infra/db/`)

**Files:**
- `connection.ts` -- SQLite connection manager. `node:sqlite` `DatabaseSync` with WAL mode, busy timeout, pragma configuration. Named statement cache. Transaction wrapper.
- `schema.ts` -- DDL for all tables: `pools`, `pool_state`, `checkpoints`, `rollback_guard`, `token_meta`, `pool_fees`, `liquidity_events`, `arb_history`. Migrations run on startup. Preserved from current `registry_schema.ts`.
- `pools.ts` -- Pool CRUD: upsert, remove, batch update states, snapshot I/O, hub-adjacent queries, metadata validation. Flattens current `registry_pools.ts` + `registry_pool_store.ts` into one module.
- `assets.ts` -- Token metadata and pool fee operations: upsert, batch upsert, query, in-memory cache. Flattens current `registry_assets.ts` + `registry_asset_store.ts` + `registry_asset_cache.ts`.
- `checkpoints.ts` -- Checkpoint and rollback guard operations. Flattens current `registry_checkpoints.ts` + `registry_checkpoint_store.ts`.
- `history.ts` -- Arb result history: insert, query, aggregate stats. Preserve from current `registry_history.ts`.
- `codec.ts` -- BigInt round-trip serialization, protocol-specific field mapping. Preserve from current `registry_codec.ts` (handles edge cases well).

**No facade class.** Each module is independent. Consumers receive the specific module they need via injection.

**Replaces:** `src/db/` (16 files, including `RegistryService`, `RegistryPoolStore`, `RegistryAssetStore`, `RegistryCheckpointStore`, `RegistryHistoryStore`, `RegistryMetaCache`, `repositories.ts`).

### 4.4 Observability (`src/infra/observability/`)

**Files:**
- `logger.ts` -- Pino logger factory. Creates child loggers with domain context. TUI mode routes to file. **No raw `console.*` anywhere in the codebase.** All 30+ current console usages replaced with structured logger calls.
- `metrics.ts` -- Prometheus-compatible counters, histograms, gauges. HTTP server on configurable port. Preserve from current `src/utils/metrics.ts`.
- `telemetry.ts` -- Bot-level telemetry aggregation: pass metrics, candidate counts, tx outcomes, watcher health. Merge current `bot_telemetry.ts`.

**Replaces:** `src/utils/logger.ts`, `src/utils/metrics.ts`, `src/app/bot_telemetry.ts`.

---

## 5. Domain Core (`src/core/`)

**All modules in this layer are pure functions with zero I/O dependencies.** They take data, return data. Fully testable in isolation.

### 5.1 Types (`src/core/types/`)

Canonical type definitions. Every type is defined exactly once.

**Files:**
- `pool.ts` -- `PoolState`, `PoolMeta`, `PoolRecord`, `PoolAddress`, `CachedPoolFee`, `CachedTokenMeta`. Protocol-specific state unions: `V2PoolState`, `V3PoolState`, `CurvePoolState`, `BalancerPoolState`, `DodoPoolState`, `WoofiPoolState`.
- `route.ts` -- `ArbPath`, `RouteEdge`, `EvaluatedRoute`, `SimulationResult`, `SimulationEdge`, `RouteState`, `SerializedPath`. Cycle enumeration types: `CycleGraph`, `CycleEnumerationOptions`.
- `execution.ts` -- `Candidate`, `CandidateEntry`, `ProfitAssessment`, `ExecutionResult`, `TransactionParams`, `DryRunResult`, `SubmissionResult`, `FlashLoanSource` (enum: `BALANCER | AAVE_V3`).
- `protocol.ts` -- `ProtocolKey`, `ProtocolDefinition`, `ProtocolClassification`, `SwapEncoding`. Protocol family sets: `V2_PROTOCOLS`, `V3_PROTOCOLS`, `CURVE_PROTOCOLS`, `BALANCER_PROTOCOLS`, `DODO_PROTOCOLS`, `WOOFI_PROTOCOLS`.
- `common.ts` -- `Address` (branded `0x${string}`), `BigIntLike`, `LoggerFn`, `LogLevel`, `FeeSnapshot`, `GasOracle`, `TokenMetadata`.

**Eliminates:** All local type redeclarations across 10+ files.

### 5.2 Math (`src/core/math/`)

**Preserved as-is from current codebase.** These are Solidity ports with exact bit-level precision.

**Files (11, unchanged logic):**
- `full_math.ts` -- 512-bit precision: `mulDiv`, `mulDivRoundingUp`, `divRoundingUp`
- `sqrt_price_math.ts` -- Q64.96 price math: delta calculations, next price from amount
- `swap_math.ts` -- Single-tick-range swap step (SwapMath.sol port)
- `tick_math.ts` -- Tick ↔ sqrtPriceX96 conversions (20 magic constants)
- `uniswap_v2.ts` -- Constant-product AMM: `getAmountOut`/`getAmountIn`, `simulateSwap`
- `uniswap_v3.ts` -- V3 swap simulator with tick crossing
- `curve.ts` -- StableSwap invariant (Newton's method for D)
- `balancer.ts` -- Weighted + stable pool math with fixed-point power series
- `dodo.ts` -- vPMM math (piecewise quadratic + linear, three R-states)
- `woofi.ts` -- sPMM: gamma-adjusted quotes, base-to-base via quote
- `index.ts` -- Barrel export

### 5.3 Assessment (`src/core/assessment/`)

**Files:**
- `profit.ts` -- Unified profit calculation. **Fixes the gas unit mismatch bug.** All values converted to MATIC wei before comparison using oracle rates. Functions: `computeNetProfit(grossProfit, gasCostWei, slippageBps, revertRiskBps, flashLoanFeeBps, oracleRate): ProfitAssessment`. Pure.
- `optimizer.ts` -- Ternary search input amount optimization. Preserve algorithm from current `assessment.ts`. Functions: `optimizeInputAmount(route, simulate, bounds): OptimizedCandidate`. Pure (takes simulator function as argument).
- `risk.ts` -- Risk model functions: `revertRiskBps(hopCount)` (500 base + 200/hop, capped 30%), `slippageAdjustment(amount, slippageBps)`, `flashLoanFee(amount, source)` (0 for Balancer, 5bps for Aave V3).
- `scorer.ts` -- Composite route scoring: weighted combination of profit, capital efficiency, gas cost, hop count, protocol diversity. Preserve from current `score_route.ts`.

### 5.4 Pricing (`src/core/pricing/`)

**Files:**
- `oracle.ts` -- Token-to-MATIC price oracle. Maintains exchange rates from V2/V3 pool observation. Pivot token routing for indirect pricing. Freshness tracking per token. Preserve core algorithm from current `price_oracle.ts`.
- `chainlink.ts` -- Chainlink MATIC/USD feed reader. **Tighten staleness from 1 hour to 5 minutes.** Cross-check deviation tolerance: 2%.
- `pivot.ts` -- Multi-hop pivot pricing through USDC/USDT/DAI/WETH/WBTC intermediaries. Multi-probe amount ladder for more accurate pricing at different trade sizes.

### 5.5 Identity (`src/core/identity.ts`)

- `normalizeEvmAddress()` -- Canonical lowercase checksummed address
- `normalizeProtocolKey()` -- Canonical protocol string
- `isPolygonSystemContract()` -- System contract detection
- `isRecord()` -- Type guard for record objects

Preserve from current `src/utils/identity.ts`. This is the most-connected node in the graph (57 edges) -- it must be stable.

### 5.6 Utilities (`src/core/utils/`)

- `bigint.ts` -- `toBigInt`, `toBigIntOrNull`, `bigintToApproxNumber`, `toFiniteNumber`. Preserve.
- `errors.ts` -- `errorMessage()` extraction from any thrown value. Preserve.
- `concurrency.ts` -- `mapWithConcurrency()`, `chunk()`. Preserve.
- `bounded_priority.ts` -- `takeTopNBy()` top-N selection. Preserve.

---

## 6. Service Layer (`src/services/`)

Each service owns its domain, has clear start/stop lifecycle, and communicates through typed interfaces.

### 6.1 Discovery Service (`src/services/discovery/`)

**Responsibility:** Find new DEX pools on Polygon.

**Files:**
- `service.ts` -- `DiscoveryService` class. `start()`, `stop()`, `discoverAll()`. Debounced background scanning with configurable interval. Iterates protocols, scans HyperSync logs, decodes events, enriches tokens on-chain, inserts into DB.
- `decoder.ts` -- Per-protocol event log decoding. `decodePairCreated()`, `decodePoolRegistered()`, `decodePlainPoolDeployed()`, etc. Merged from current `discovery_helpers.ts` + protocol-specific decode logic.
- `enrichment.ts` -- On-chain token metadata hydration via HyperRPC multicall: decimals, symbol, name. Merge current `token_hydrator.ts` + `token_hydrator_helpers.ts`. Skip Polygon system contracts.
- `curve_factory.ts` -- Curve factory-specific discovery via `pool_count`/`pool_list` RPC + `get_coins` multicall. Preserve from current `curve_list_factory.ts` (complex, correct).

**Interface:**
```typescript
interface DiscoveryService {
  start(): Promise<void>;
  stop(): void;
  discoverAll(): Promise<DiscoveryResult>;
  discoverProtocol(protocol: ProtocolDefinition): Promise<DiscoveredPool[]>;
}
```

**Replaces:** `src/arb/discover.ts`, `src/arb/discovery_coordinator.ts`, `src/arb/discovery_helpers.ts`, `src/state/enrichment/`.

### 6.2 Watcher Service (`src/services/watcher/`)

**Responsibility:** Keep pool state fresh via HyperSync event streaming.

**Files:**
- `service.ts` -- `WatcherService` class. `start()`, `stop()`, `getStatus()`. Manages watcher lifecycle, exposes state cache. Emits `StateChanged` events with list of affected pool addresses.
- `poll_loop.ts` -- Main poll loop: query HyperSync -> decode logs -> apply state mutations -> checkpoint. Adaptive sleep based on chain height advancement. Interruptible with shutdown awareness.
- `log_handler.ts` -- Topic0 dispatch map. Routes decoded logs to protocol-specific state mutation handlers. Supports V2 Sync, V3 Swap/Mint/Burn, Balancer PoolBalanceChanged, Curve TokenExchange, DODO DODOSwap, WOOFi WooSwap.
- `state_ops.ts` -- Protocol-specific state mutation functions. V2: update reserves from Sync event. V3: update sqrtPriceX96, tick, liquidity; insert/remove ticks from Mint/Burn. Balancer/Curve/DODO/WOOFi: full state refresh on relevant events. **Preserve all logic from current `watcher_state_ops.ts`.**
- `reorg.ts` -- Rollback guard comparison. Detects chain reorgs by comparing `parentHash` chain. Triggers DB rollback to last known good block. Preserve from current `watcher_reorg.ts` + `reorg_detect.ts`.
- `filter.ts` -- Address filter construction and extension. Sharding for large pool sets (>10K addresses). Dynamic filter updates when new pools are discovered.

**Interface:**
```typescript
interface WatcherService {
  start(): Promise<void>;
  stop(): void;
  getStatus(): WatcherStatus;
  getStateCache(): ReadonlyMap<Address, PoolState>;
  onStateChanged(handler: (affected: Address[]) => void): void;
  extendFilter(addresses: Address[]): void;
}
```

**Replaces:** `src/state/watcher.ts` + 19 watcher_*.ts files + `src/state/cache_utils.ts`.

### 6.3 Hydration Service (`src/services/hydration/`)

**Responsibility:** Startup warmup and background state hydration for pools without watcher coverage.

**Files:**
- `service.ts` -- `HydrationService` class. Manages warmup (startup) and quiet-pool sweep (ongoing).
- `warmup.ts` -- Multi-protocol batch state hydration. Hub-pair pools first (synchronous), then long-tail pools (deferred). V2 via multicall `getReserves`, V3 via `slot0` + tick bitmap + tick data, Curve/Balancer/DODO/WOOFi via protocol-specific RPC calls. Preserve core logic from current `src/state/warmup.ts`.
- `pollers.ts` -- Per-protocol RPC pollers: `pollV2`, `pollV3`, `pollCurve`, `pollBalancer`, `pollDodo`, `pollWoofi`. Consolidate 6 current `poll_*.ts` files into one module with shared fetch/normalize pattern.
- `sweep.ts` -- Background missing-state hydration. Scans registry for pools without cached state, hydrates in batches with retry backoff. Preserve from current `quiet_pool_sweep.ts`.

**Replaces:** `src/state/warmup.ts`, `src/state/poll_*.ts` (6 files), `src/state/poller_base.ts`, `src/state/normalizer.ts`, `src/state/state_multicall_hydrator.ts`, `src/app/quiet_pool_sweep.ts`, `src/app/runner_hydration.ts`.

### 6.4 Strategy Engine (`src/services/strategy/`)

**Responsibility:** Find and evaluate arbitrage opportunities.

**Files:**
- `graph.ts` -- Token adjacency graph with live `stateRef` pointers. Multi-protocol edges. Log-weight annotation (Bellman-Ford criterion). Serialization for worker transfer. **Preserve core algorithm from current `src/routing/graph.ts`.**
- `finder.ts` -- Arbitrage cycle finder. 2-hop/3-hop forward BFS. 4-hop bidirectional meet-in-middle. Cumulative fee annotation. Liquidity floor pruning ($5K USD minimum). Dual-graph strategy (hub-first + full-graph). **Preserve core algorithms from current `src/routing/finder.ts`.**
- `simulator.ts` -- Multi-protocol route simulation. Dispatches to correct math module per protocol. Ternary-search input optimization via `core/assessment/optimizer.ts`. **Preserve from current `src/routing/simulator.ts`.**
- `evaluator.ts` -- Worker thread pool for parallel route evaluation. Persistent workers with auto-heal on crash. Message passing for EVALUATE and ENUMERATE payloads. **Preserve worker architecture from current `src/routing/worker_pool.ts` + `persistent_worker.ts`.**
- `cache.ts` -- Merged route cache + predictive state cache. Top-N profitable route storage. Pool-indexed for fast changed-pool lookup. Shadow state pre-computation for sub-100ms execution. Merge current `route_cache.ts` + `predictive_state_cache.ts` + `predictive_cache_adapter.ts`.
- `pipeline.ts` -- Full assessment pipeline: enumerate -> filter fresh -> simulate -> optimize top-N -> assess profitability -> partition profitable -> rank. Merge current `candidate_pipeline.ts` + `search.ts` + `filter_fresh_candidates.ts` + `optimization_candidates.ts`.
- `backrunner.ts` -- **NEW.** Detects large pending swaps from `MempoolService` signals. Computes expected price dislocation per affected pool. Searches for arb cycles that profit from the dislocation by temporarily adjusting pool state in the graph, running cycle enumeration on affected tokens, and assessing profitability. Emits `BackrunCandidate` with the original pending TX hash for bundle construction.
- `topology.ts` -- Persistent cycle cache on disk. Load/save/validate serialized enumerations. Preserve from current `topology_cache.ts`.
- `liquidity.ts` -- Pool liquidity estimator in WMATIC-wei. Protocol-specific TVL calculation. Preserve from current `src/routing/liquidity.ts`.

**Interface:**
```typescript
interface StrategyEngine {
  start(): Promise<void>;
  stop(): void;
  rebuildGraph(pools: PoolRecord[], state: Map<Address, PoolState>): void;
  searchOnce(feeSnapshot: FeeSnapshot): Promise<CandidatePipelineResult>;
  searchBackrun(signal: LargeSwapSignal): Promise<BackrunCandidate | null>;
  invalidatePools(addresses: Address[]): void;
}
```

**Replaces:** `src/routing/` (22 files) + `src/arb/search.ts` + `src/arb/route_revalidation.ts` + `src/arb/opportunity_engine.ts`.

### 6.5 Execution Service (`src/services/execution/`)

**Responsibility:** Build, validate, and submit profitable transactions.

**Files:**
- `service.ts` -- `ExecutionService` class. `execute(candidate): ExecutionResult`. Manages quarantine, execution-in-flight guard, nonce synchronization. Merge current `execution_coordinator.ts`.
- `flash_loans.ts` -- **NEW.** Flash loan source selection logic. `selectFlashLoanSource(token, amount): FlashLoanSource`. Balancer preferred (zero-fee on Polygon). Aave V3 fallback when token not available in Balancer vault or when Balancer vault has insufficient liquidity for the requested amount. Queries on-chain liquidity for both sources.
- `calldata.ts` -- Multi-protocol calldata encoder. Encodes `Call[]` arrays for `ArbExecutor.executeArb()` across V2, V3, Curve, Balancer, DODO, WOOFi protocols. Handles protocol-specific swap function selectors, token index resolution, receiver routing. **Preserve from current `src/execution/calldata.ts`.**
- `builder.ts` -- Transaction builder. Assembles complete tx objects: calldata + gas params (EIP-1559) + flash params + route hash verification. Built-tx validation: full calldata decode + verify before signing. Merge current `build_tx.ts`.
- `submitter.ts` -- Multi-strategy submission. Private relay racing (first-wins). Alchemy `eth_sendPrivateTransaction`. `eth_sendBundle` for bundle-capable relays. Public RPC fallback. Adaptive receipt timeout. Merge current `send_tx.ts` + `private_tx.ts` + `tx_sniper.ts`.
- `gas.ts` -- Unified gas management. Background gas oracle (2s poll). EIP-1559 fee calculation (`maxFee = baseFee * 2 + priorityFee`). Polygon-specific clamping (30-500 gwei priority fee). Gas estimate caching with 2-minute TTL. EMA-based gas multiplier feedback. Profit-margin-scaled priority fee (1x-5x). Merge current `gas.ts` + `gas_estimator.ts` + `gas_adjustment.ts`.
- `nonce.ts` -- Per-account nonce manager with local increment, pending tracking, resync on network. Preserve from current `nonce_manager.ts`.
- `attempt_log.ts` -- Structured attempt logging. Stages, outcomes, sink registration. SQLite persistence for post-mortem analysis. Merge current `attempt_log.ts` + `tx_attempt_store.ts`.

**Interface:**
```typescript
interface ExecutionService {
  start(): Promise<void>;
  stop(): void;
  execute(candidate: Candidate): Promise<ExecutionResult>;
  getGasOracle(): GasOracle;
  getFeeSnapshot(): FeeSnapshot;
  isQuarantined(routeKey: string): boolean;
}
```

**Replaces:** `src/execution/` (15 files) + `src/arb/execution_coordinator.ts`.

### 6.6 Mempool Service (`src/services/mempool/`)

**Responsibility:** Monitor pending transactions for state freshness and backrun opportunities.

**Files:**
- `service.ts` -- `MempoolService` class. WebSocket subscription to `newPendingTransactions` and `newHeads`. Coalesces pending TX notifications (100ms TTL). Emits typed signals.
- `decoder.ts` -- Swap calldata recognition across all supported protocols. Identifies target pool, swap direction, and approximate size from pending TX input data.
- `signals.ts` -- Signal types: `LargeSwapDetected { txHash, pool, tokenIn, tokenOut, estimatedSize }`, `PoolStateInvalidated { addresses }`, `NewBlock { number, baseFee }`.

**Interface:**
```typescript
interface MempoolService {
  start(): Promise<void>;
  stop(): void;
  onLargeSwap(handler: (signal: LargeSwapSignal) => void): void;
  onStateInvalidated(handler: (addresses: Address[]) => void): void;
  onNewBlock(handler: (block: NewBlockSignal) => void): void;
}
```

**Replaces:** `src/app/mempool_watcher.ts`.

---

## 7. Orchestrator (`src/orchestrator/`)

Replaces `src/app/runner.ts` (2916 lines).

**Files:**
- `boot.ts` -- ~100 lines. Create infrastructure (DB, RPC clients, HyperSync, logger). Create services (Discovery, Watcher, Hydration, Strategy, Execution, Mempool). Wire signal connections (Watcher.onStateChanged -> Strategy.invalidatePools, Mempool.onLargeSwap -> Strategy.searchBackrun). Start all services.
- `pass_loop.ts` -- ~100 lines. Main arb pass loop: get fee snapshot -> run strategy search -> for each profitable candidate: execute -> log result -> update telemetry. Configurable interval, max passes, loop/single modes.
- `shutdown.ts` -- ~50 lines. Graceful shutdown: stop Execution (finish in-flight) -> stop Mempool -> stop Watcher -> stop Strategy workers -> flush DB -> exit. Configurable timeout (default 10s).
- `config.ts` -- Configuration loading and validation. Zod schema for all configuration domains.

**Replaces:** `src/app/runner.ts`, `src/app/runner_app.ts`, `src/app/lifecycle.ts`, `src/app/runner_opportunity_engine.ts`, `src/app/helpers.ts`, `src/app/watcher_configurator.ts`, `src/app/resource_tuning.ts`, `src/app/pricing_service.ts`.

---

## 8. CLI (`src/cli/`)

**Files:**
- `main.ts` -- Entry point (`runner.ts` at project root becomes a thin shim). Parse CLI args, load config, create orchestrator, run.
- `tui.ts` -- Terminal UI renderer + types. Preserve from current `src/tui/` (solid implementation). Merge `renderer.ts` + `types.ts` into one file.

**Replaces:** `runner.ts` (project root), `src/tui/` (3 files), `src/config/cli.ts`.

### 8.3 Operator Log (`src/cli/operator_log.ts`)

Activity-label formatting for the TUI and structured logs. Maps event names to human-readable activity labels. Hub cooldown detail formatting. Routing universe metadata formatting. Preserve core mapping logic from current `src/app/operator_log.ts` (1154 lines) but simplify: many labels are verbose and the file contains formatting logic that belongs in the TUI renderer.

**Replaces:** `src/app/operator_log.ts`.

---

## 9. Configuration (`src/config/`)

**Files:**
- `schema.ts` -- Zod schemas for all configuration. Grouped by domain:
  - `RpcConfig`: `polygonRpcUrls`, `executionRpcUrl`, `gasEstimationRpcUrl`, `hyperRpcUrl`, timeouts
  - `GasConfig`: `pollIntervalMs`, `bufferBps`, `multiplier`, `priorityFeeFloorGwei`, `priorityFeeCeilingGwei`, `maxBidMultiplier`
  - `RoutingConfig`: `maxHops`, `maxTotalPaths`, `maxPathsToOptimize`, `cycleRefreshIntervalMs`, `liquidityFloorUsd`, `workerCount`, `evalWorkerThreshold`
  - `ExecutionConfig`: `minProfitWei`, `slippageBps`, `revertRiskBps`, `flashLoanFeeBps`, `privateRelayUrls`, `dryRunBeforeSubmit`
  - `DiscoveryConfig`: protocol-specific start blocks, `refreshIntervalMs`
  - `WatcherConfig`: `batchSize`, `maxBlocksPerRequest`, `idleSleepMs`
  - `PredictiveCacheConfig`: `enabled`, `maxPaths`, `precomputeCount`, `refreshIntervalMs`
  - `MempoolConfig`: `enabled`, `websocketUrl`, `coalesceTtlMs`, `largeSwapThresholdUsd`
- `loader.ts` -- Load from `process.env` -> validate with Zod -> merge with defaults -> freeze. Fail fast on invalid config with clear error messages.
- `defaults.ts` -- All default values in one canonical location.
- `addresses.ts` -- All contract addresses (routers, vaults, factories, hub tokens). Consolidate from current `execution/addresses.ts` + inline constants in `graph.ts`, `poll_balancer.ts`, `enrichment/balancer.ts`, `woofi_shared.ts`, etc. No more duplicated `BALANCER_VAULT` address.

**Replaces:** `src/config/index.ts` (745 lines), `src/config/rpc_env.ts`, `src/config/cli.ts`, `src/execution/addresses.ts`, scattered hardcoded addresses.

---

## 10. Protocol Definitions (`src/protocols/`)

**Preserve as-is.** Protocol definitions are pure data (addresses, ABIs, event signatures). Minor cleanup only:

- **Keep:** All protocol definition files (`balancer_v2.ts`, `curve_*.ts`, `dodo_v2.ts`, `quickswap_v3.ts`, `kyberswap_elastic.ts`, `woofi.ts`, `woofi_shared.ts`, `factories.ts`, `classification.ts`, `index.ts`)
- **Delete:** `contract_catalog.ts` (392 lines, zero importers, reference artifact only)
- **Move:** Factory addresses from inline in `index.ts` to `config/addresses.ts`. Protocol files reference addresses by name rather than hardcoding.

---

## 11. Smart Contract Updates (`sol/`)

### 11.1 ArbExecutor V2

Extend current contract (don't rewrite -- it's tested):

```solidity
// New: Aave V3 flash loan support
import {IFlashLoanSimpleReceiver} from "@aave/v3-core/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import {IPoolAddressesProvider} from "@aave/v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPool} from "@aave/v3-core/contracts/interfaces/IPool.sol";

contract ArbExecutorV2 is IFlashLoanRecipient, IFlashLoanSimpleReceiver {
    IPool public immutable aavePool;

    enum FlashLoanSource { BALANCER, AAVE_V3 }

    struct FlashParams {
        address profitToken;
        uint256 minProfit;
        uint256 deadline;
        bytes32 routeHash;
        Call[] calls;
        FlashLoanSource source; // NEW
    }

    function executeArbWithAave(
        address asset,
        uint256 amount,
        FlashParams calldata params
    ) external onlyOperator {
        // Request Aave V3 flash loan
        aavePool.flashLoanSimple(address(this), asset, amount, abi.encode(params), 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(aavePool), "caller must be Aave pool");
        require(initiator == address(this), "initiator must be self");
        FlashParams memory fp = abi.decode(params, (FlashParams));
        // Execute calls, repay amount + premium, assert profit
        _executeRouteAndAssertProfit(fp, amount + premium);
        IERC20(asset).approve(address(aavePool), amount + premium);
        return true;
    }
}
```

### 11.2 Security Fix

Remove hardcoded Alchemy API key from `sol/d`. Replace with:
```bash
forge script script/ArbExecutor.s.sol \
  --rpc-url "$POLYGON_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

---

## 12. Testing Strategy

### 12.1 Test Framework

- **Vitest** -- Fast, ESM-native, excellent TypeScript support, built-in coverage.
- **No mocking frameworks.** Tests use explicit test doubles (factory functions that return typed stubs).
- **Property-based tests** for math modules using `fast-check`.

### 12.2 Test Plan

| Module | Test File | Type | Priority | Description |
|--------|-----------|------|----------|-------------|
| `core/math/uniswap_v2` | `uniswap_v2.test.ts` | Unit + property | P0 | Constant product invariant: `k = x * y` preserved after swap. Edge cases: zero amounts, max uint256. |
| `core/math/uniswap_v3` | `uniswap_v3.test.ts` | Unit + property | P0 | Tick crossing correctness. Liquidity bounds. Multi-step swap invariants. |
| `core/math/curve` | `curve.test.ts` | Unit | P0 | Newton's method convergence. D invariant preservation. |
| `core/math/balancer` | `balancer.test.ts` | Unit | P0 | Weighted pool: product invariant. Stable pool: Newton convergence. |
| `core/math/dodo` | `dodo.test.ts` | Unit | P0 | vPMM R-state transitions. Piecewise pricing correctness. |
| `core/math/woofi` | `woofi.test.ts` | Unit | P0 | sPMM gamma adjustments. Base-to-base via quote intermediate. |
| `core/math/full_math` | `full_math.test.ts` | Unit + property | P0 | 512-bit overflow cases. Rounding direction correctness. |
| `core/math/tick_math` | `tick_math.test.ts` | Unit | P0 | Known tick/price pairs from Uniswap V3 reference. Boundary ticks. |
| `core/assessment/profit` | `profit.test.ts` | Unit | P0 | **Gas unit mismatch fix verification.** MATIC vs token unit conversion. Edge: zero gas, max gas, exotic token decimals. |
| `core/assessment/optimizer` | `optimizer.test.ts` | Unit | P0 | Ternary search convergence. Monotonicity assumptions. |
| `core/assessment/risk` | `risk.test.ts` | Unit | P1 | Revert risk scaling by hop count. Slippage calculation. Flash loan fee by source. |
| `services/execution/calldata` | `calldata.test.ts` | Unit | P0 | Encode/decode roundtrip for each protocol. Correct function selectors. Token index ordering. |
| `services/execution/flash_loans` | `flash_loans.test.ts` | Unit | P1 | Source selection: Balancer preferred, Aave fallback. Insufficient liquidity handling. |
| `services/execution/gas` | `gas.test.ts` | Unit | P2 | EIP-1559 fee calculation. Priority fee clamping. Budget capping. |
| `services/strategy/finder` | `finder.test.ts` | Unit + benchmark | P1 | Known-graph cycle detection. Deduplication. Bidirectional correctness. Performance regression (synthetic 300-token graph). |
| `services/strategy/simulator` | `simulator.test.ts` | Integration | P1 | Multi-protocol route simulation with known pool states. |
| `services/strategy/backrunner` | `backrunner.test.ts` | Unit | P2 | Price dislocation calculation. Candidate generation from pending swap. |
| `config/schema` | `schema.test.ts` | Unit | P1 | Valid config passes. Missing required fields fail with clear messages. Type coercion works (string -> number). |

### 12.3 Test Coverage Targets

- `core/math/`: 100% line coverage
- `core/assessment/`: 100% line coverage
- `services/execution/calldata.ts`: 100% branch coverage
- Everything else: 80%+ line coverage

---

## 13. Dead Code Elimination

### Files to delete

| File | Reason |
|------|--------|
| `src/utils/validation_job.ts` | Zero importers, never called |
| `src/utils/multicall.ts` | Zero importers, superseded by `enrichment/rpc.ts` multicall |
| `src/state/pool_record.ts` | 13-line re-export shim |
| `src/routing/worker.ts` | Legacy one-shot worker, superseded by `persistent_worker.ts` |
| `src/protocols/contract_catalog.ts` | Reference artifact, zero runtime importers |
| `reproduce_finder_performance.ts` | Standalone benchmark, absorb into test suite |

### Exports to remove

28 identified unused exports (see analysis report). Each should be verified as truly unused before removal. Notable:
- `rankRoutes`, `selectBestRoute` (routing)
- `PollDodo`, `PollWoofi`, `PollBalancer` (state -- replaced by consolidated pollers)
- `getMetrics` (utils)
- Multiple gas estimation exports that are internal-only

---

## 14. Error Handling Policy

### Current: 40 empty catch blocks

### New policy:
1. **Never swallow errors silently.** Every catch block must either:
   - Log at `warn` or `error` level with context, OR
   - Re-throw as a typed error, OR
   - Return a typed `Result<T, E>` (discriminated union)
2. **Fallback catches** (e.g., parsing that falls back to a default) must log at `debug` level with the original error.
3. **Each service has a typed error hierarchy.** `DiscoveryError`, `WatcherError`, `StrategyError`, `ExecutionError` with specific subtypes.
4. **Circuit breaker** at the orchestrator level: if N consecutive executions fail within M minutes, pause execution and alert.

---

## 15. File Summary

### New directory structure

```
src/
├── cli/
│   ├── main.ts
│   └── tui.ts
├── config/
│   ├── schema.ts
│   ├── loader.ts
│   ├── defaults.ts
│   └── addresses.ts
├── core/
│   ├── types/
│   │   ├── pool.ts
│   │   ├── route.ts
│   │   ├── execution.ts
│   │   ├── protocol.ts
│   │   └── common.ts
│   ├── math/
│   │   ├── full_math.ts
│   │   ├── sqrt_price_math.ts
│   │   ├── swap_math.ts
│   │   ├── tick_math.ts
│   │   ├── uniswap_v2.ts
│   │   ├── uniswap_v3.ts
│   │   ├── curve.ts
│   │   ├── balancer.ts
│   │   ├── dodo.ts
│   │   ├── woofi.ts
│   │   └── index.ts
│   ├── assessment/
│   │   ├── profit.ts
│   │   ├── optimizer.ts
│   │   ├── risk.ts
│   │   └── scorer.ts
│   ├── pricing/
│   │   ├── oracle.ts
│   │   ├── chainlink.ts
│   │   └── pivot.ts
│   ├── identity.ts
│   └── utils/
│       ├── bigint.ts
│       ├── errors.ts
│       ├── concurrency.ts
│       └── bounded_priority.ts
├── infra/
│   ├── rpc/
│   │   ├── endpoint_pool.ts
│   │   ├── client_factory.ts
│   │   └── retry.ts
│   ├── hypersync/
│   │   ├── client.ts
│   │   ├── stream.ts
│   │   ├── query.ts
│   │   └── types.ts
│   ├── db/
│   │   ├── connection.ts
│   │   ├── schema.ts
│   │   ├── pools.ts
│   │   ├── assets.ts
│   │   ├── checkpoints.ts
│   │   ├── history.ts
│   │   └── codec.ts
│   └── observability/
│       ├── logger.ts
│       ├── metrics.ts
│       └── telemetry.ts
├── orchestrator/
│   ├── boot.ts
│   ├── pass_loop.ts
│   ├── shutdown.ts
│   └── config.ts
├── protocols/
│   ├── balancer_v2.ts
│   ├── curve_stable_factory.ts
│   ├── curve_crypto_factory.ts
│   ├── curve_main_registry.ts
│   ├── curve_stableswap_ng.ts
│   ├── curve_tricrypto_ng.ts
│   ├── curve_list_factory.ts
│   ├── dodo_v2.ts
│   ├── quickswap_v3.ts
│   ├── kyberswap_elastic.ts
│   ├── woofi.ts
│   ├── woofi_shared.ts
│   ├── factories.ts
│   ├── classification.ts
│   └── index.ts
├── services/
│   ├── discovery/
│   │   ├── service.ts
│   │   ├── decoder.ts
│   │   ├── enrichment.ts
│   │   └── curve_factory.ts
│   ├── watcher/
│   │   ├── service.ts
│   │   ├── poll_loop.ts
│   │   ├── log_handler.ts
│   │   ├── state_ops.ts
│   │   ├── reorg.ts
│   │   └── filter.ts
│   ├── hydration/
│   │   ├── service.ts
│   │   ├── warmup.ts
│   │   ├── pollers.ts
│   │   └── sweep.ts
│   ├── strategy/
│   │   ├── graph.ts
│   │   ├── finder.ts
│   │   ├── simulator.ts
│   │   ├── evaluator.ts
│   │   ├── cache.ts
│   │   ├── pipeline.ts
│   │   ├── backrunner.ts
│   │   ├── topology.ts
│   │   └── liquidity.ts
│   ├── execution/
│   │   ├── service.ts
│   │   ├── flash_loans.ts
│   │   ├── calldata.ts
│   │   ├── builder.ts
│   │   ├── submitter.ts
│   │   ├── gas.ts
│   │   ├── nonce.ts
│   │   └── attempt_log.ts
│   └── mempool/
│       ├── service.ts
│       ├── decoder.ts
│       └── signals.ts
└── tests/
    ├── core/
    │   ├── math/
    │   │   ├── uniswap_v2.test.ts
    │   │   ├── uniswap_v3.test.ts
    │   │   ├── curve.test.ts
    │   │   ├── balancer.test.ts
    │   │   ├── dodo.test.ts
    │   │   ├── woofi.test.ts
    │   │   ├── full_math.test.ts
    │   │   └── tick_math.test.ts
    │   ├── assessment/
    │   │   ├── profit.test.ts
    │   │   ├── optimizer.test.ts
    │   │   └── risk.test.ts
    │   └── identity.test.ts
    ├── services/
    │   ├── execution/
    │   │   ├── calldata.test.ts
    │   │   ├── flash_loans.test.ts
    │   │   └── gas.test.ts
    │   └── strategy/
    │       ├── finder.test.ts
    │       ├── simulator.test.ts
    │       └── backrunner.test.ts
    └── config/
        └── schema.test.ts

Total: ~83 source files + 20 test files (vs current ~155 source files + 0 tests)
```

---

## 16. Migration Strategy

Since this is development/testing only (not production), we can do a clean-room rewrite without incremental migration:

1. **Phase 1 (Weeks 1-3): Core + Infrastructure.** Build `src/core/` and `src/infra/`. Write all P0 tests. Verify math modules produce identical outputs to current code.
2. **Phase 2 (Weeks 3-5): Services.** Build all services. Integration test each service independently against testnet/fork.
3. **Phase 3 (Weeks 5-7): Orchestrator + CLI.** Wire everything together. End-to-end test on Polygon mainnet (observe mode, no execution).
4. **Phase 4 (Weeks 7-8): New Features.** Aave V3 flash loans, backrunning, circuit breaker.
5. **Phase 5 (Weeks 8-9): Smart Contracts.** Deploy ArbExecutorV2 to testnet. Integration test flash loan paths.
6. **Phase 6 (Weeks 9-10): Optimization + Polish.** Performance benchmarks. Gas oracle tuning. Predictive cache optimization. Documentation.

Each phase produces a working checkpoint that can be reviewed independently.

---

## 17. Risks

| Risk | Mitigation |
|------|-----------|
| Math rounding errors in port | Preserve code as-is, add property-based tests comparing outputs to known reference values |
| New flash loan source introduces bugs | Test Aave V3 path extensively on testnet before mainnet |
| Backrunner creates latency overhead | Make backrunning async and configurable. Default off until validated. |
| Scope creep | Each phase has a clear definition of done. New ideas go to a backlog, not into current phase. |
| Worker pool regression | Port worker_pool.ts architecture directly. Benchmark against synthetic graph to detect regressions. |
