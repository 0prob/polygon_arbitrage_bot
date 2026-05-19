# Graph Report - t  (2026-05-18)

## Corpus Check
- 158 files · ~52,653 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 947 nodes · 1400 edges · 83 communities (65 shown, 18 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e817648c`
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
- [[_COMMUNITY_Community 17|Community 17]]
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
- [[_COMMUNITY_Community 45|Community 45]]
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
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]

## God Nodes (most connected - your core abstractions)
1. `renderFrame()` - 16 edges
2. `RpcEndpointPool` - 14 edges
3. `encodeRoute()` - 13 edges
4. `runPassLoop()` - 12 edges
5. `simulateV3Swap()` - 12 edges
6. `compilerOptions` - 12 edges
7. `computeProfit()` - 11 edges
8. `simulateRoute()` - 11 edges
9. `pollLoop()` - 11 edges
10. `scripts` - 11 edges

## Surprising Connections (you probably didn't know these)
- `createRootLogger()` --calls--> `pino`  [INFERRED]
  src/infra/observability/logger.ts → package.json
- `runPassLoop()` --calls--> `withTimeout()`  [INFERRED]
  pass_loop.ts → src/infra/rpc/retry.ts
- `runPassLoop()` --calls--> `buildGraph()`  [EXTRACTED]
  pass_loop.ts → src/services/strategy/graph.ts
- `main()` --calls--> `runPassLoop()`  [EXTRACTED]
  src/cli/main.ts → pass_loop.ts
- `pollLoop()` --calls--> `signal`  [INFERRED]
  src/services/watcher/poll_loop.ts → src/services/strategy/backrunner.test.ts

## Communities (83 total, 18 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (33): dependencies, @envio-dev/hypersync-client, tsx, viem, zod, devDependencies, eslint, eslint-config-prettier (+25 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (16): Architecture, CLI (`src/cli/`), code:block1 (git clone <repo>), code:block2 (pnpm start), Config (`src/config/`), Configuration, Core (`src/core/`), Development (+8 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (25): bigintFromString, DiscoveryConfig, DiscoveryConfigSchema, ExecutionConfig, ExecutionConfigSchema, GasConfig, GasConfigSchema, HypersyncConfig (+17 more)

### Community 3 - "Community 3"
Cohesion: 0.05
Nodes (43): config, mockGet, mockGetHeight, MockHypersyncClient, mockRecv, mockStream, normalized, buildLogQuery() (+35 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (10): BALANCER_FAMILY_KEYS, CURVE_FAMILY_KEYS, DecodedPool, DODO_FAMILY_KEYS, ProtocolDefinition, ProtocolFamily, ProtocolKey, V2_FAMILY_KEYS (+2 more)

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
Cohesion: 0.15
Nodes (13): EvaluatedRoute, evaluatePaths(), evaluatePathsParallel(), A, B, badEdges, cycles, edges (+5 more)

### Community 9 - "Community 9"
Cohesion: 0.17
Nodes (11): applyMigrationV1ToV2(), ensureSchema(), addrCol, colNames, cols, idCol, indexes, indexNames (+3 more)

### Community 10 - "Community 10"
Cohesion: 0.20
Nodes (8): A, B, badEdge, baseOpts, cycles, edges, highMinProfit, result

### Community 11 - "Community 11"
Cohesion: 0.22
Nodes (8): count, mode, outer, row, rows, s1, s2, tx

### Community 12 - "Community 12"
Cohesion: 0.20
Nodes (8): A, all, cache, edges, edges1, edges2, touched, SwapEdge

### Community 13 - "Community 13"
Cohesion: 0.40
Nodes (4): Add Progress Instrumentation Implementation Plan, code:typescript (import { describe, it, expect, vi } from "vitest";), Task 1: Create Test for Progress Instrumentation, Task 2: Implement Progress Instrumentation

### Community 14 - "Community 14"
Cohesion: 0.25
Nodes (7): bigUint20, bigUint40, out, out1, out2, result, state

### Community 15 - "Community 15"
Cohesion: 0.21
Nodes (10): buildGraph(), buildHubGraph(), RoutingGraph, graph, hubTokens, pool, pool1, pool2 (+2 more)

### Community 16 - "Community 16"
Cohesion: 0.18
Nodes (4): EXECUTION_RPC_URL, GAS_ESTIMATION_RPC_URL, POLYGON_RPC_URL, POLYGON_RPC_URLS

### Community 17 - "Community 17"
Cohesion: 0.18
Nodes (10): code:typescript (// Inside runPassLoop, before the loop iterating over `resul), code:typescript (// Around executionService.execute call), code:typescript (// In src/orchestrator/boot.ts, near the end of bootApplicat), code:typescript (// In pass_loop.ts, inside the loop where pools.length === 0), code:bash (git add src/orchestrator/boot.ts src/orchestrator/pass_loop.), Task 1: Progress Instrumentation & Debug Logging, Task 2: Fix Bootup Pool Discovery & Hydration, Task 3: Trigger Discovery in Pass Loop (+2 more)

### Community 18 - "Community 18"
Cohesion: 0.33
Nodes (6): best, ep, make(), makePool(), pool, spy

### Community 19 - "Community 19"
Cohesion: 0.07
Nodes (58): assertValidRoute(), buildArbTx(), BuilderConfig, BuilderOptions, BuilderRouteInput, BuiltTransaction, normalizeEvmAddress(), asAddress() (+50 more)

### Community 20 - "Community 20"
Cohesion: 0.22
Nodes (3): CandidateExecution, ExecutionResult, ExecutionService

### Community 21 - "Community 21"
Cohesion: 0.22
Nodes (8): code:typescript (import { type PublicClient, getContract } from "viem";), code:typescript (// src/orchestrator/boot.ts), code:typescript (// Add an optional progress callback to DiscoveryService), code:bash (git add src/services/discovery/curve_discovery.ts src/orches), Curve Pool Discovery Implementation Plan, Task 1: Create Curve Discovery Logic, Task 2: Instrument DiscoveryService for TUI, Task 3: Verify and Commit

### Community 22 - "Community 22"
Cohesion: 0.22
Nodes (3): FlashLoanQuote, LiquidityChecker, RpcClientForLiquidity

### Community 23 - "Community 23"
Cohesion: 0.40
Nodes (4): active, pool, state, v2Pools

### Community 25 - "Community 25"
Cohesion: 0.40
Nodes (4): DEFAULT_RATES, out, result, state

### Community 26 - "Community 26"
Cohesion: 0.08
Nodes (17): NonceFetcher, NonceManager, fetchNonce, nm, EndpointPoolOptions, ensureHttps(), RpcEndpoint, errorMessage() (+9 more)

### Community 27 - "Community 27"
Cohesion: 0.13
Nodes (15): optimizeInputAmount(), OptimizeOptions, mkResult(), result, simulate(), DEFAULT_WEIGHTS, ScoringWeights, ArbPath (+7 more)

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
Cohesion: 0.20
Nodes (13): getCheckpoint(), rollbackToCheckpoint(), saveCheckpoint(), pollLoop(), sleep(), checkReorg(), detectReorg(), pick() (+5 more)

### Community 32 - "Community 32"
Cohesion: 0.13
Nodes (20): BlockField, client, createConfigError(), createHypersyncClient(), createHyperSyncUnavailableError(), createUnavailableHypersyncClientImpl(), Decoder, ensureClient() (+12 more)

### Community 34 - "Community 34"
Cohesion: 0.33
Nodes (5): FACTORY_ABI, fetchCurvePools(), factoryAddress, mockClient, mockFactory

### Community 49 - "Community 49"
Cohesion: 0.16
Nodes (22): dedupeLogs(), logger, sortLogs(), buildLogQuery(), commitWatcherStatesBatch(), CORE_STATE_KEYS, mergeStateIntoCache(), mergeWatcherState() (+14 more)

### Community 50 - "Community 50"
Cohesion: 0.36
Nodes (6): childLogger(), createLogSinkStream(), createRootLogger(), LEVEL_LABELS, LoggerOptions, pino

### Community 51 - "Community 51"
Cohesion: 0.20
Nodes (19): age(), BotActivityProgress, BotOpportunityRow, fmt(), fmtDur(), fmtProgress(), fmtWei(), latestEvent() (+11 more)

### Community 53 - "Community 53"
Cohesion: 0.12
Nodes (22): computeProfit(), ComputeProfitOptions, gasCostMaticWei(), invalidAssessment(), maticWeiToTokens(), roiMicroUnits(), baseOpts, r2 (+14 more)

### Community 54 - "Community 54"
Cohesion: 0.12
Nodes (13): clampPriorityFee(), DEFAULT_GAS_CONFIG, FeeSnapshot, GasOracle, GasOracleConfig, PolygonGasHints, scalePriorityFeeByProfitMargin(), fetchGas (+5 more)

### Community 55 - "Community 55"
Cohesion: 0.15
Nodes (6): DecodedSwap, decodeSwapCalldata(), SELECTORS, DEFAULT_MEMPOOL_OPTIONS, MempoolService, MempoolServiceOptions

### Community 56 - "Community 56"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, esModuleInterop, module, moduleResolution, noEmit, noUnusedLocals, noUnusedParameters (+5 more)

### Community 57 - "Community 57"
Cohesion: 0.16
Nodes (9): DecodedPoolEvent, TokenMetaFetcher, TokenMetaRemote, DiscoveryResult, DiscoveryService, DiscoveryServiceDeps, PoolStateFetcher, StateCache (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.11
Nodes (10): AttemptEntry, AttemptLogSink, logAttempt(), sinks, AlchemyPrivateTxSubmitter, PrivateRelaySubmitter, PublicSubmitter, SubmissionResult (+2 more)

### Community 59 - "Community 59"
Cohesion: 0.18
Nodes (4): CircuitBreaker, CircuitBreakerOptions, CircuitState, DEFAULT_CIRCUIT_BREAKER_OPTIONS

### Community 60 - "Community 60"
Cohesion: 0.20
Nodes (16): RuntimeContext, getGasPriceWei(), runPassLoop(), sleep(), mockContext, mockExecute, mockProfitable, mockStateUpdate (+8 more)

### Community 62 - "Community 62"
Cohesion: 0.21
Nodes (8): DEFAULT_WARMUP_OPTIONS, PoolStateFetcher, syncBatch(), pool, USDC, WETH, WarmupOptions, warmupStateCache()

### Community 66 - "Community 66"
Cohesion: 0.15
Nodes (18): normalizeAddressForDb(), parseJson(), poolMetaRowToObject(), poolRowToObject(), PROTOCOL_BIGINT_ARRAY_FIELDS, PROTOCOL_BIGINT_SCALAR_FIELDS, protocolClass(), rehydrateStateData() (+10 more)

### Community 68 - "Community 68"
Cohesion: 0.33
Nodes (9): decodeCurvePoolAdded(), decodePairCreated(), decodePoolDeployed(), decodePoolRegistered(), extractAddress(), extractAddressFromTopic(), log, r (+1 more)

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (5): code:typescript (<<<<), code:bash (git add .), Task 1: Fix WatcherService Drain, Task 2: Final Verification & Commit, Workspace Repair Implementation Plan

### Community 75 - "Community 75"
Cohesion: 0.18
Nodes (14): asPoolState(), asTickData(), getSortedTicks(), nextInitializedTickOptimized(), poolCacheKey(), quoteV3(), simulateV3Swap(), sortedTicksCache (+6 more)

### Community 76 - "Community 76"
Cohesion: 0.19
Nodes (13): BackrunCandidate, Backrunner, BackrunnerOptions, LargeSwapSignal, extractGasResult(), inferTokenIdx(), inferZeroForOne(), normalizeProtocol() (+5 more)

### Community 77 - "Community 77"
Cohesion: 0.21
Nodes (10): DEFAULTS, deepMerge(), ENV_TO_PATH, envToOverrides(), loadConfig(), loadConfigOrDie(), AppConfig, AppConfigSchema (+2 more)

### Community 78 - "Community 78"
Cohesion: 0.21
Nodes (11): buildHandlerMap(), dispatchLog(), getHandler(), getHandlerMap(), LogHandler, LogHandlerContext, TOPIC0, topicArray() (+3 more)

### Community 79 - "Community 79"
Cohesion: 0.29
Nodes (12): asStateRecord(), decodedBigInt(), decodedValue(), ensureV3Fee(), parsePoolMetadataValue(), resolveV2FeeDenominator(), resolveV2FeeNumerator(), resolveV3Fee() (+4 more)

### Community 81 - "Community 81"
Cohesion: 0.53
Nodes (5): createBotState(), main(), BotState, startTui(), bootApplication()

### Community 82 - "Community 82"
Cohesion: 0.40
Nodes (5): isTickRecord(), normalizeWatcherTicks(), tickEntriesFrom(), toTickBigInt(), updateTickState()

## Knowledge Gaps
- **402 isolated node(s):** `code:typescript (import { type PublicClient, getContract } from "viem";)`, `code:typescript (// src/orchestrator/boot.ts)`, `code:typescript (// Add an optional progress callback to DiscoveryService)`, `code:bash (git add src/services/discovery/curve_discovery.ts src/orches)`, `BotOpportunityRow` (+397 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRootLogger()` connect `Community 50` to `Community 32`, `Community 57`, `Community 81`, `Community 49`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `RouteStateCache` connect `Community 76` to `Community 8`, `Community 57`, `Community 27`, `Community 53`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `simulateV3Swap()` connect `Community 75` to `Community 19`, `Community 76`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **What connects `code:typescript (import { type PublicClient, getContract } from "viem";)`, `code:typescript (// src/orchestrator/boot.ts)`, `code:typescript (// Add an optional progress callback to DiscoveryService)` to the rest of the system?**
  _402 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.058823529411764705 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._