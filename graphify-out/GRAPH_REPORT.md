# Graph Report - t  (2026-05-18)

## Corpus Check
- 154 files · ~51,476 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 748 nodes · 983 edges · 73 communities (54 shown, 19 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5be3ab64`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]

## God Nodes (most connected - your core abstractions)
1. `renderFrame()` - 16 edges
2. `RpcEndpointPool` - 14 edges
3. `compilerOptions` - 12 edges
4. `scripts` - 11 edges
5. `runPassLoop()` - 9 edges
6. `RpcEndpoint` - 9 edges
7. `NonceManager` - 9 edges
8. `pollLoop()` - 9 edges
9. `GasOracle` - 9 edges
10. `MempoolService` - 9 edges

## Surprising Connections (you probably didn't know these)
- `createRootLogger()` --calls--> `pino`  [INFERRED]
  src/infra/observability/logger.ts → package.json
- `pollLoop()` --calls--> `signal`  [INFERRED]
  src/services/watcher/poll_loop.ts → src/services/strategy/backrunner.test.ts
- `bootApplication()` --calls--> `createRootLogger()`  [EXTRACTED]
  src/orchestrator/boot.ts → src/infra/observability/logger.ts
- `main()` --calls--> `loadConfig()`  [EXTRACTED]
  src/cli/main.ts → src/config/loader.ts
- `runPassLoop()` --calls--> `enumerateCycles()`  [EXTRACTED]
  src/orchestrator/pass_loop.ts → src/services/strategy/finder.ts

## Communities (73 total, 19 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (34): dependencies, @envio-dev/hypersync-client, pino, tsx, viem, zod, devDependencies, eslint (+26 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (16): Architecture, CLI (`src/cli/`), code:block1 (git clone <repo>), code:block2 (pnpm start), Config (`src/config/`), Configuration, Core (`src/core/`), Development (+8 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (35): DEFAULTS, deepMerge(), ENV_TO_PATH, envToOverrides(), loadConfig(), loadConfigOrDie(), AppConfig, AppConfigSchema (+27 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (37): log, r, buildLogQuery(), computeTopic0(), DEFAULT_BLOCK_FIELDS, DEFAULT_LOG_FIELDS, normalizeEventSignature(), normalizeTopic() (+29 more)

### Community 5 - "Community 5"
Cohesion: 0.13
Nodes (14): baseState, cycle, edge1, edge2, enumerateFn, options, POOL_A, POOL_B (+6 more)

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (14): A, B, C, cycles, e1, e2, graph, key (+6 more)

### Community 7 - "Community 7"
Cohesion: 0.15
Nodes (12): A, B, cache, edge, edges, p1, p2, poolA (+4 more)

### Community 8 - "Community 8"
Cohesion: 0.18
Nodes (9): A, B, badEdges, cycles, edges, goodEdges, p1, p2 (+1 more)

### Community 9 - "Community 9"
Cohesion: 0.20
Nodes (9): addrCol, colNames, cols, idCol, indexes, indexNames, tableNames, tables (+1 more)

### Community 10 - "Community 10"
Cohesion: 0.20
Nodes (8): A, B, badEdge, baseOpts, cycles, edges, highMinProfit, result

### Community 11 - "Community 11"
Cohesion: 0.22
Nodes (8): count, mode, outer, row, rows, s1, s2, tx

### Community 12 - "Community 12"
Cohesion: 0.22
Nodes (7): A, all, cache, edges, edges1, edges2, touched

### Community 13 - "Community 13"
Cohesion: 0.40
Nodes (4): Add Progress Instrumentation Implementation Plan, code:typescript (import { describe, it, expect, vi } from "vitest";), Task 1: Create Test for Progress Instrumentation, Task 2: Implement Progress Instrumentation

### Community 14 - "Community 14"
Cohesion: 0.25
Nodes (7): bigUint20, bigUint40, out, out1, out2, result, state

### Community 15 - "Community 15"
Cohesion: 0.25
Nodes (7): graph, hubTokens, pool, pool1, pool2, state, stateMap

### Community 16 - "Community 16"
Cohesion: 0.29
Nodes (6): fetchGas, first, oracle, scaled, second, snap

### Community 18 - "Community 18"
Cohesion: 0.33
Nodes (6): best, ep, make(), makePool(), pool, spy

### Community 19 - "Community 19"
Cohesion: 0.33
Nodes (4): quote, result, sim, state

### Community 21 - "Community 21"
Cohesion: 0.40
Nodes (4): baseOpts, r2, r4, result

### Community 22 - "Community 22"
Cohesion: 0.40
Nodes (4): data, m, result, ticks

### Community 23 - "Community 23"
Cohesion: 0.40
Nodes (4): active, pool, state, v2Pools

### Community 24 - "Community 24"
Cohesion: 0.40
Nodes (3): pool, USDC, WETH

### Community 25 - "Community 25"
Cohesion: 0.40
Nodes (4): DEFAULT_RATES, out, result, state

### Community 26 - "Community 26"
Cohesion: 0.09
Nodes (12): NonceFetcher, NonceManager, EndpointPoolOptions, ensureHttps(), RpcEndpoint, errorMessage(), isAuthError(), isNoDataError() (+4 more)

### Community 27 - "Community 27"
Cohesion: 0.67
Nodes (3): mkResult(), result, simulate()

### Community 28 - "Community 28"
Cohesion: 0.50
Nodes (3): out, result, state

### Community 29 - "Community 29"
Cohesion: 0.50
Nodes (3): addrs, known, result

### Community 30 - "Community 30"
Cohesion: 0.50
Nodes (3): service, signals, tx

### Community 31 - "Community 31"
Cohesion: 0.50
Nodes (3): customRetryable, fn, logger

### Community 32 - "Community 32"
Cohesion: 0.10
Nodes (23): BlockField, createConfigError(), createHypersyncClient(), createHyperSyncUnavailableError(), createUnavailableHypersyncClientImpl(), ensureClient(), ensureModule(), HypersyncError (+15 more)

### Community 49 - "Community 49"
Cohesion: 0.06
Nodes (63): client, Decoder, buildHandlerMap(), dispatchLog(), getHandler(), getHandlerMap(), LogHandler, LogHandlerContext (+55 more)

### Community 50 - "Community 50"
Cohesion: 0.43
Nodes (5): childLogger(), createLogSinkStream(), createRootLogger(), LEVEL_LABELS, LoggerOptions

### Community 51 - "Community 51"
Cohesion: 0.20
Nodes (19): age(), BotActivityProgress, BotOpportunityRow, fmt(), fmtDur(), fmtProgress(), fmtWei(), latestEvent() (+11 more)

### Community 53 - "Community 53"
Cohesion: 0.16
Nodes (16): computeProfit(), ComputeProfitOptions, gasCostMaticWei(), invalidAssessment(), maticWeiToTokens(), roiMicroUnits(), tokensToMaticWei(), CandidateEntry (+8 more)

### Community 54 - "Community 54"
Cohesion: 0.16
Nodes (6): clampPriorityFee(), DEFAULT_GAS_CONFIG, FeeSnapshot, GasOracle, GasOracleConfig, PolygonGasHints

### Community 55 - "Community 55"
Cohesion: 0.15
Nodes (6): DecodedSwap, decodeSwapCalldata(), SELECTORS, DEFAULT_MEMPOOL_OPTIONS, MempoolService, MempoolServiceOptions

### Community 56 - "Community 56"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, esModuleInterop, module, moduleResolution, noEmit, noUnusedLocals, noUnusedParameters (+5 more)

### Community 57 - "Community 57"
Cohesion: 0.36
Nodes (6): DecodedPoolEvent, DiscoveryResult, DiscoveryServiceDeps, PoolStateFetcher, StateCache, Logger

### Community 58 - "Community 58"
Cohesion: 0.08
Nodes (17): AttemptEntry, AttemptLogSink, logAttempt(), sinks, assertValidRoute(), buildArbTx(), BuilderConfig, BuilderOptions (+9 more)

### Community 59 - "Community 59"
Cohesion: 0.18
Nodes (4): CircuitBreaker, CircuitBreakerOptions, CircuitState, DEFAULT_CIRCUIT_BREAKER_OPTIONS

### Community 60 - "Community 60"
Cohesion: 0.10
Nodes (23): createBotState(), main(), BotState, startTui(), CandidateExecution, ExecutionResult, ExecutionService, bootApplication() (+15 more)

### Community 62 - "Community 62"
Cohesion: 0.38
Nodes (5): DEFAULT_WARMUP_OPTIONS, PoolStateFetcher, syncBatch(), WarmupOptions, warmupStateCache()

### Community 66 - "Community 66"
Cohesion: 0.25
Nodes (8): normalizeAddressForDb(), parseJson(), poolMetaRowToObject(), poolRowToObject(), PROTOCOL_BIGINT_ARRAY_FIELDS, PROTOCOL_BIGINT_SCALAR_FIELDS, protocolClass(), rehydrateStateData()

### Community 67 - "Community 67"
Cohesion: 0.43
Nodes (7): extractGasResult(), inferTokenIdx(), inferZeroForOne(), normalizeProtocol(), simulateHop(), simulateRoute(), SimulationEdge

### Community 68 - "Community 68"
Cohesion: 0.52
Nodes (6): decodeCurvePoolAdded(), decodePairCreated(), decodePoolDeployed(), decodePoolRegistered(), extractAddress(), extractAddressFromTopic()

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (5): code:typescript (<<<<), code:bash (git add .), Task 1: Fix WatcherService Drain, Task 2: Final Verification & Commit, Workspace Repair Implementation Plan

## Knowledge Gaps
- **330 isolated node(s):** `code:typescript (import { describe, it, expect, vi } from "vitest";)`, `Task 2: Implement Progress Instrumentation`, `mockGetHeight`, `mockGet`, `mockRecv` (+325 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRootLogger()` connect `Community 50` to `Community 0`, `Community 57`, `Community 60`, `Community 49`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Why does `pino` connect `Community 0` to `Community 50`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `code:typescript (import { describe, it, expect, vi } from "vitest";)`, `Task 2: Implement Progress Instrumentation`, `mockGetHeight` to the rest of the system?**
  _330 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05714285714285714 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.059379217273954114 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.05735430157261795 - nodes in this community are weakly interconnected._