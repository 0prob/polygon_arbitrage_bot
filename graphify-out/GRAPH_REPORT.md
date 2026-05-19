# Graph Report - t  (2026-05-18)

## Corpus Check
- 158 files · ~53,625 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1005 nodes · 1470 edges · 84 communities (64 shown, 20 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `904840f9`
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
- [[_COMMUNITY_Community 47|Community 47]]
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
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]

## God Nodes (most connected - your core abstractions)
1. `renderFrame()` - 16 edges
2. `CompatDatabase` - 15 edges
3. `RpcEndpointPool` - 14 edges
4. `runPassLoop()` - 14 edges
5. `encodeRoute()` - 13 edges
6. `simulateV3Swap()` - 12 edges
7. `compilerOptions` - 12 edges
8. `computeProfit()` - 11 edges
9. `simulateRoute()` - 11 edges
10. `pollLoop()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `pollLoop()` --calls--> `signal`  [INFERRED]
  services/watcher/poll_loop.ts → src/services/strategy/backrunner.test.ts
- `createRootLogger()` --calls--> `pino`  [INFERRED]
  src/infra/observability/logger.ts → package.json
- `withRetry()` --calls--> `fn`  [INFERRED]
  infra/rpc/retry.ts → src/infra/rpc/retry.test.ts
- `upsertPoolMeta()` --calls--> `stringifyWithBigInt()`  [EXTRACTED]
  src/infra/db/pools.ts → infra/db/codec.ts
- `getPoolMeta()` --calls--> `poolRowToObject()`  [EXTRACTED]
  src/infra/db/pools.ts → infra/db/codec.ts

## Communities (84 total, 20 thin omitted)

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
Cohesion: 0.07
Nodes (36): buildLogQuery(), computeTopic0(), computeTopic0s(), DEFAULT_BLOCK_FIELDS, DEFAULT_LOG_FIELDS, normalizeEventSignature(), normalizeLogFilter(), normalizeTopic() (+28 more)

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
Nodes (12): EvaluatedRoute, evaluatePaths(), evaluatePathsParallel(), A, B, badEdges, cycles, edges (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.18
Nodes (14): asPoolState(), asTickData(), getSortedTicks(), nextInitializedTickOptimized(), poolCacheKey(), quoteV3(), simulateV3Swap(), sortedTicksCache (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.17
Nodes (10): FoundCycle, PipelineResult, A, B, badEdge, baseOpts, cycles, edges (+2 more)

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
Cohesion: 0.06
Nodes (19): NonceFetcher, NonceManager, fetchNonce, nm, EndpointPoolOptions, ensureHttps(), errorMessage(), RpcEndpoint (+11 more)

### Community 27 - "Community 27"
Cohesion: 0.25
Nodes (7): ArbPath, CycleEnumerationOptions, RouteEdge, RouteIdentityEdge, RouteResultCore, RouteResultTrace, SimulatedHopResult

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
Cohesion: 0.08
Nodes (16): CompatDatabase, CompatStatement, createDatabase(), createInMemoryDatabase(), SQLInputValue, applyMigrationV1ToV2(), ensureSchema(), addrCol (+8 more)

### Community 32 - "Community 32"
Cohesion: 0.10
Nodes (24): BlockField, client, createConfigError(), createHypersyncClient(), createHyperSyncUnavailableError(), createUnavailableHypersyncClientImpl(), ensureClient(), ensureModule() (+16 more)

### Community 34 - "Community 34"
Cohesion: 0.29
Nodes (5): FACTORY_ABI, fetchCurvePools(), factoryAddress, mockClient, mockFactory

### Community 49 - "Community 49"
Cohesion: 0.06
Nodes (66): getCheckpoint(), saveCheckpoint(), Decoder, WATCHER_SIGNATURES, buildHandlerMap(), dispatchLog(), getHandler(), getHandlerMap() (+58 more)

### Community 50 - "Community 50"
Cohesion: 0.27
Nodes (8): PoolStateFetcher, StateCache, childLogger(), createLogSinkStream(), createRootLogger(), LEVEL_LABELS, Logger, LoggerOptions

### Community 51 - "Community 51"
Cohesion: 0.21
Nodes (19): age(), BotActivityProgress, BotOpportunityRow, fmt(), fmtDur(), fmtProgress(), fmtWei(), latestEvent() (+11 more)

### Community 53 - "Community 53"
Cohesion: 0.10
Nodes (24): computeProfit(), ComputeProfitOptions, gasCostMaticWei(), invalidAssessment(), maticWeiToTokens(), roiMicroUnits(), baseOpts, r2 (+16 more)

### Community 54 - "Community 54"
Cohesion: 0.18
Nodes (11): DEFAULT_GAS_CONFIG, FeeSnapshot, GasOracleConfig, PolygonGasHints, scalePriorityFeeByProfitMargin(), fetchGas, first, oracle (+3 more)

### Community 55 - "Community 55"
Cohesion: 0.17
Nodes (4): DecodedSwap, decodeSwapCalldata(), SELECTORS, MempoolService

### Community 56 - "Community 56"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, esModuleInterop, module, moduleResolution, noEmit, noUnusedLocals, noUnusedParameters (+5 more)

### Community 57 - "Community 57"
Cohesion: 0.21
Nodes (7): DecodedPoolEvent, TokenMetaFetcher, TokenMetaRemote, DiscoveryResult, DiscoveryServiceDeps, DEFAULT_MEMPOOL_OPTIONS, MempoolServiceOptions

### Community 58 - "Community 58"
Cohesion: 0.09
Nodes (12): AttemptEntry, AttemptLogSink, logAttempt(), sinks, BuiltTransaction, AlchemyPrivateTxSubmitter, hostnameFromUrl(), PrivateRelaySubmitter (+4 more)

### Community 59 - "Community 59"
Cohesion: 0.18
Nodes (4): CircuitBreaker, CircuitBreakerOptions, CircuitState, DEFAULT_CIRCUIT_BREAKER_OPTIONS

### Community 60 - "Community 60"
Cohesion: 0.28
Nodes (13): BotState, CandidateExecution, RuntimeContext, buildCandidate(), getGasPriceWei(), runPassLoop(), sleep(), weiToGwei() (+5 more)

### Community 62 - "Community 62"
Cohesion: 0.14
Nodes (9): HydrationService, DEFAULT_WARMUP_OPTIONS, PoolStateFetcher, syncBatch(), pool, USDC, WETH, WarmupOptions (+1 more)

### Community 63 - "Community 63"
Cohesion: 0.83
Nodes (3): extractReserves(), poolLiquidityWmatic(), toBigintOrUndefined()

### Community 66 - "Community 66"
Cohesion: 0.14
Nodes (18): normalizeAddressForDb(), parseJson(), poolMetaRowToObject(), poolRowToObject(), PROTOCOL_BIGINT_ARRAY_FIELDS, PROTOCOL_BIGINT_SCALAR_FIELDS, protocolClass(), rehydrateStateData() (+10 more)

### Community 68 - "Community 68"
Cohesion: 0.21
Nodes (13): decodeCurvePoolAdded(), decodePairCreated(), decodePoolDeployed(), decodePoolRegistered(), extractAddress(), extractAddressFromTopic(), PROTOCOL_BALANCER, PROTOCOL_CURVE (+5 more)

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (5): code:typescript (<<<<), code:bash (git add .), Task 1: Fix WatcherService Drain, Task 2: Final Verification & Commit, Workspace Repair Implementation Plan

### Community 76 - "Community 76"
Cohesion: 0.20
Nodes (12): BackrunCandidate, Backrunner, BackrunnerOptions, LargeSwapSignal, extractGasResult(), inferTokenIdx(), inferZeroForOne(), normalizeProtocol() (+4 more)

### Community 78 - "Community 78"
Cohesion: 0.22
Nodes (6): EvmAddress, isEvmAddress(), normalizeEvmAddress(), normalizeProtocolKey(), POLYGON_SYSTEM_PREFIXES, ProtocolKey

### Community 79 - "Community 79"
Cohesion: 0.36
Nodes (6): optimizeInputAmount(), OptimizeOptions, mkResult(), result, simulate(), RouteSimulationResult

### Community 80 - "Community 80"
Cohesion: 0.31
Nodes (8): createBotState(), main(), startTui(), updateState(), setHypersyncDefaults(), bootApplication(), shutdownApplication(), stopService()

### Community 81 - "Community 81"
Cohesion: 0.31
Nodes (8): mockContext, mockExecute, mockProfitable, mockStateUpdate, enumerateCycles(), feeLogWeight(), find2HopCycles(), find3HopCycles()

### Community 84 - "Community 84"
Cohesion: 0.33
Nodes (3): DEFAULT_WEIGHTS, ScoringWeights, EvaluatedRoute

## Knowledge Gaps
- **408 isolated node(s):** `POLYGON_RPC_URL`, `POLYGON_RPC_URLS`, `GAS_ESTIMATION_RPC_URL`, `EXECUTION_RPC_URL`, `bigintFromString` (+403 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRootLogger()` connect `Community 50` to `Community 80`, `Community 57`, `Community 0`, `Community 49`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `buildArbTx()` connect `Community 19` to `Community 60`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Why does `AppConfig` connect `Community 2` to `Community 57`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **What connects `POLYGON_RPC_URL`, `POLYGON_RPC_URLS`, `GAS_ESTIMATION_RPC_URL` to the rest of the system?**
  _408 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.058029689608636977 - nodes in this community are weakly interconnected._