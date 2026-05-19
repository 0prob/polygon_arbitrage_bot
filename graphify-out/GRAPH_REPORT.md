# Graph Report - t  (2026-05-18)

## Corpus Check
- 158 files · ~52,807 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 967 nodes · 1432 edges · 90 communities (71 shown, 19 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6bf854bf`
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
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]

## God Nodes (most connected - your core abstractions)
1. `renderFrame()` - 16 edges
2. `RpcEndpointPool` - 14 edges
3. `encodeRoute()` - 13 edges
4. `runPassLoop()` - 12 edges
5. `simulateV3Swap()` - 12 edges
6. `compilerOptions` - 12 edges
7. `scripts` - 11 edges
8. `computeProfit()` - 11 edges
9. `simulateRoute()` - 11 edges
10. `pollLoop()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `createRootLogger()` --calls--> `pino`  [INFERRED]
  src/infra/observability/logger.ts → package.json
- `runPassLoop()` --calls--> `withTimeout()`  [INFERRED]
  pass_loop.ts → src/infra/rpc/retry.ts
- `runPassLoop()` --calls--> `buildGraph()`  [EXTRACTED]
  pass_loop.ts → src/services/strategy/graph.ts
- `runPassLoop()` --calls--> `enumerateCycles()`  [EXTRACTED]
  pass_loop.ts → src/services/strategy/finder.ts
- `main()` --calls--> `runPassLoop()`  [EXTRACTED]
  src/cli/main.ts → pass_loop.ts

## Communities (90 total, 19 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (35): dependencies, @envio-dev/hypersync-client, pino, tsx, viem, zod, devDependencies, eslint (+27 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (16): Architecture, CLI (`src/cli/`), code:block1 (git clone <repo>), code:block2 (pnpm start), Config (`src/config/`), Configuration, Core (`src/core/`), Development (+8 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (35): DEFAULTS, deepMerge(), ENV_TO_PATH, envToOverrides(), loadConfig(), loadConfigOrDie(), AppConfig, AppConfigSchema (+27 more)

### Community 3 - "Community 3"
Cohesion: 0.12
Nodes (18): buildLogQuery(), computeTopic0(), computeTopic0s(), DEFAULT_BLOCK_FIELDS, DEFAULT_LOG_FIELDS, normalizeEventSignature(), normalizeLogFilter(), normalizeTopic() (+10 more)

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
Cohesion: 0.13
Nodes (20): evaluatePaths(), extractGasResult(), inferTokenIdx(), inferZeroForOne(), normalizeProtocol(), simulateHop(), simulateRoute(), SimulationEdge (+12 more)

### Community 8 - "Community 8"
Cohesion: 0.15
Nodes (12): EvaluatedRoute, evaluatePathsParallel(), A, B, badEdges, cycles, edges, goodEdges (+4 more)

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
Nodes (57): assertValidRoute(), buildArbTx(), BuilderConfig, BuilderOptions, BuilderRouteInput, normalizeEvmAddress(), asAddress(), BALANCER_PROTOCOLS (+49 more)

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
Cohesion: 0.12
Nodes (13): EndpointPoolOptions, ensureHttps(), RpcEndpoint, errorMessage(), isAuthError(), isNoDataError(), isRateLimitError(), isRetryableError() (+5 more)

### Community 27 - "Community 27"
Cohesion: 0.13
Nodes (12): DEFAULT_WEIGHTS, ScoringWeights, PipelineResult, ArbPath, CycleEnumerationOptions, EvaluatedRoute, RouteEdge, RouteIdentityEdge (+4 more)

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
Cohesion: 0.15
Nodes (5): CompatDatabase, CompatStatement, createDatabase(), createInMemoryDatabase(), SQLInputValue

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
Cohesion: 0.27
Nodes (8): PoolStateFetcher, StateCache, childLogger(), createLogSinkStream(), createRootLogger(), LEVEL_LABELS, Logger, LoggerOptions

### Community 51 - "Community 51"
Cohesion: 0.15
Nodes (24): createBotState(), main(), age(), BotActivityProgress, BotOpportunityRow, BotState, fmt(), fmtDur() (+16 more)

### Community 53 - "Community 53"
Cohesion: 0.23
Nodes (12): computeProfit(), ComputeProfitOptions, gasCostMaticWei(), invalidAssessment(), maticWeiToTokens(), roiMicroUnits(), baseOpts, r2 (+4 more)

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
Cohesion: 0.20
Nodes (6): DecodedPoolEvent, TokenMetaFetcher, TokenMetaRemote, DiscoveryResult, DiscoveryService, DiscoveryServiceDeps

### Community 58 - "Community 58"
Cohesion: 0.10
Nodes (11): AttemptEntry, AttemptLogSink, logAttempt(), sinks, BuiltTransaction, AlchemyPrivateTxSubmitter, PrivateRelaySubmitter, PublicSubmitter (+3 more)

### Community 59 - "Community 59"
Cohesion: 0.18
Nodes (4): CircuitBreaker, CircuitBreakerOptions, CircuitState, DEFAULT_CIRCUIT_BREAKER_OPTIONS

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (9): CandidateExecution, getGasPriceWei(), runPassLoop(), sleep(), weiToGwei(), withTimeout(), routeKeyFromEdges(), evaluatePipeline() (+1 more)

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
Cohesion: 0.29
Nodes (4): BackrunCandidate, Backrunner, BackrunnerOptions, LargeSwapSignal

### Community 77 - "Community 77"
Cohesion: 0.18
Nodes (5): NonceFetcher, NonceManager, fetchNonce, nm, ExecutionResult

### Community 78 - "Community 78"
Cohesion: 0.22
Nodes (8): CandidateEntry, CandidatePipelineResult, DryRunResult, ExecutableCandidate, ExecutionOutcome, ProfitAssessment, SubmissionResult, TransactionParams

### Community 79 - "Community 79"
Cohesion: 0.39
Nodes (6): optimizeInputAmount(), OptimizeOptions, mkResult(), result, simulate(), RouteSimulationResult

### Community 80 - "Community 80"
Cohesion: 0.33
Nodes (5): RuntimeContext, mockContext, mockExecute, mockProfitable, mockStateUpdate

### Community 81 - "Community 81"
Cohesion: 0.80
Nodes (4): enumerateCycles(), feeLogWeight(), find2HopCycles(), find3HopCycles()

### Community 82 - "Community 82"
Cohesion: 0.20
Nodes (13): getCheckpoint(), rollbackToCheckpoint(), saveCheckpoint(), pollLoop(), sleep(), checkReorg(), detectReorg(), pick() (+5 more)

### Community 83 - "Community 83"
Cohesion: 0.21
Nodes (11): buildHandlerMap(), dispatchLog(), getHandler(), getHandlerMap(), LogHandler, LogHandlerContext, TOPIC0, topicArray() (+3 more)

### Community 84 - "Community 84"
Cohesion: 0.27
Nodes (10): fetchAllLogs(), FetchAllLogsResult, pageLogsFromResponse(), parseBlock(), parseOptionalBlock(), mockClient, query, HypersyncClientRuntime (+2 more)

### Community 85 - "Community 85"
Cohesion: 0.29
Nodes (12): asStateRecord(), decodedBigInt(), decodedValue(), ensureV3Fee(), parsePoolMetadataValue(), resolveV2FeeDenominator(), resolveV2FeeNumerator(), resolveV3Fee() (+4 more)

### Community 86 - "Community 86"
Cohesion: 0.20
Nodes (8): config, mockGet, mockGetHeight, MockHypersyncClient, mockRecv, mockStream, normalized, HyperSyncClientConfig

### Community 87 - "Community 87"
Cohesion: 0.25
Nodes (7): DecodedLogValue, HyperSyncBlockHeader, HypersyncDecodedLog, HyperSyncGetResponse, HyperSyncLogFilter, HyperSyncStream, StreamProgress

### Community 89 - "Community 89"
Cohesion: 0.40
Nodes (5): isTickRecord(), normalizeWatcherTicks(), tickEntriesFrom(), toTickBigInt(), updateTickState()

## Knowledge Gaps
- **404 isolated node(s):** `name`, `version`, `type`, `main`, `packageManager` (+399 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRootLogger()` connect `Community 50` to `Community 0`, `Community 32`, `Community 49`, `Community 51`, `Community 57`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `RouteStateCache` connect `Community 27` to `Community 8`, `Community 57`, `Community 76`, `Community 7`?**
  _High betweenness centrality (0.081) - this node is a cross-community bridge._
- **Why does `simulateV3Swap()` connect `Community 75` to `Community 19`, `Community 7`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **What connects `name`, `version`, `type` to the rest of the system?**
  _404 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.059379217273954114 - nodes in this community are weakly interconnected._