# Graph Report - t  (2026-05-19)

## Corpus Check
- 189 files · ~74,547 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1278 nodes · 1864 edges · 125 communities (103 shown, 22 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7d1f0db6`
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
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 98|Community 98]]
- [[_COMMUNITY_Community 99|Community 99]]
- [[_COMMUNITY_Community 100|Community 100]]
- [[_COMMUNITY_Community 101|Community 101]]
- [[_COMMUNITY_Community 103|Community 103]]
- [[_COMMUNITY_Community 104|Community 104]]
- [[_COMMUNITY_Community 105|Community 105]]
- [[_COMMUNITY_Community 106|Community 106]]
- [[_COMMUNITY_Community 107|Community 107]]
- [[_COMMUNITY_Community 108|Community 108]]
- [[_COMMUNITY_Community 109|Community 109]]
- [[_COMMUNITY_Community 110|Community 110]]
- [[_COMMUNITY_Community 111|Community 111]]
- [[_COMMUNITY_Community 112|Community 112]]
- [[_COMMUNITY_Community 113|Community 113]]
- [[_COMMUNITY_Community 114|Community 114]]
- [[_COMMUNITY_Community 115|Community 115]]
- [[_COMMUNITY_Community 116|Community 116]]
- [[_COMMUNITY_Community 117|Community 117]]
- [[_COMMUNITY_Community 118|Community 118]]
- [[_COMMUNITY_Community 126|Community 126]]
- [[_COMMUNITY_Community 127|Community 127]]
- [[_COMMUNITY_Community 128|Community 128]]
- [[_COMMUNITY_Community 129|Community 129]]

## God Nodes (most connected - your core abstractions)
1. `CompatDatabase` - 19 edges
2. `File Structure` - 17 edges
3. `runPassLoop()` - 16 edges
4. `renderFrame()` - 16 edges
5. `encodeRoute()` - 14 edges
6. `scripts` - 14 edges
7. `RpcEndpointPool` - 14 edges
8. `simulateV3Swap()` - 14 edges
9. `simulateRoute()` - 12 edges
10. `HyperIndex Ingestion Layer` - 12 edges

## Surprising Connections (you probably didn't know these)
- `pollLoop()` --calls--> `signal`  [INFERRED]
  services/watcher/poll_loop.ts → src/services/strategy/backrunner.test.ts
- `createRootLogger()` --calls--> `pino`  [INFERRED]
  src/infra/observability/logger.ts → package.json
- `withRetry()` --calls--> `fn`  [INFERRED]
  infra/rpc/retry.ts → src/infra/rpc/retry.test.ts
- `deriveTightV3PriceLimit()` --calls--> `simulateV3Swap()`  [EXTRACTED]
  calldata.ts → src/core/math/uniswap_v3.ts
- `encodeKyberElasticHop()` --calls--> `simulateV3Swap()`  [EXTRACTED]
  calldata.ts → src/core/math/uniswap_v3.ts

## Communities (125 total, 22 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (45): dependencies, envio, viem, devDependencies, typescript, name, private, scripts (+37 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (26): 1. HyperIndex Schema, 2. HyperIndex Config, 3. HyperIndex Handlers, 4. Bot-side Simulation, 5. Calldata Encoding, 6. ArbExecutor Contract, 7. Execution Integration, 8. ABI File (+18 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (35): DEFAULTS, deepMerge(), ENV_TO_PATH, envToOverrides(), loadConfig(), loadConfigOrDie(), AppConfig, AppConfigSchema (+27 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (35): buildLogQuery(), computeTopic0(), computeTopic0s(), DEFAULT_BLOCK_FIELDS, DEFAULT_LOG_FIELDS, normalizeEventSignature(), normalizeLogFilter(), normalizeTopic() (+27 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (14): BALANCER_FAMILY_KEYS, CURVE_FAMILY_KEYS, DecodedPool, DODO_FAMILY_KEYS, isBalancerProtocol(), isCurveProtocol(), isV2Protocol(), isV3Protocol() (+6 more)

### Community 5 - "Community 5"
Cohesion: 0.13
Nodes (14): baseState, cycle, edge1, edge2, enumerateFn, options, POOL_A, POOL_B (+6 more)

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (14): A, B, C, cycles, e1, e2, graph, key (+6 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (36): Architecture, Bun Migration, code:block1 (┌──────────────────────────────────────────────────────────┐), code:typescript (// If HyperIndex DB has no state for a pool, fall back to on), code:block11 (arb-t/), code:yaml (name: arb_bot_ingestion), code:graphql (type PoolMeta {), code:typescript (import { indexer } from "envio";) (+28 more)

### Community 8 - "Community 8"
Cohesion: 0.15
Nodes (12): EvaluatedRoute, evaluatePaths(), evaluatePathsParallel(), A, B, badEdges, cycles, edges (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.18
Nodes (4): CircuitBreaker, CircuitBreakerOptions, CircuitState, DEFAULT_CIRCUIT_BREAKER_OPTIONS

### Community 10 - "Community 10"
Cohesion: 0.20
Nodes (8): A, B, badEdge, baseOpts, cycles, edges, highMinProfit, result

### Community 11 - "Community 11"
Cohesion: 0.22
Nodes (8): count, mode, outer, row, rows, s1, s2, tx

### Community 12 - "Community 12"
Cohesion: 0.04
Nodes (45): ADDR_A, ADDR_B, ADDR_C, Address, ALL_TESTS, BASE_ENV, DIAG_RESULTS, diagCalldata (+37 more)

### Community 13 - "Community 13"
Cohesion: 0.40
Nodes (4): Add Progress Instrumentation Implementation Plan, code:typescript (import { describe, it, expect, vi } from "vitest";), Task 1: Create Test for Progress Instrumentation, Task 2: Implement Progress Instrumentation

### Community 14 - "Community 14"
Cohesion: 0.25
Nodes (7): bigUint20, bigUint40, out, out1, out2, result, state

### Community 15 - "Community 15"
Cohesion: 0.11
Nodes (18): A, all, cache, edges, edges1, edges2, touched, buildGraph() (+10 more)

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
Nodes (59): assertValidRoute(), buildArbTx(), BuilderConfig, BuilderOptions, BuilderRouteInput, normalizeEvmAddress(), asAddress(), BALANCER_PROTOCOLS (+51 more)

### Community 20 - "Community 20"
Cohesion: 0.18
Nodes (14): asPoolState(), asTickData(), getSortedTicks(), nextInitializedTickOptimized(), poolCacheKey(), quoteV3(), simulateV3Swap(), sortedTicksCache (+6 more)

### Community 21 - "Community 21"
Cohesion: 0.22
Nodes (8): code:typescript (import { type PublicClient, getContract } from "viem";), code:typescript (// src/orchestrator/boot.ts), code:typescript (// Add an optional progress callback to DiscoveryService), code:bash (git add src/services/discovery/curve_discovery.ts src/orches), Curve Pool Discovery Implementation Plan, Task 1: Create Curve Discovery Logic, Task 2: Instrument DiscoveryService for TUI, Task 3: Verify and Commit

### Community 22 - "Community 22"
Cohesion: 0.35
Nodes (9): createDatabase(), buildStateCacheFromHyperIndex(), getHiDbPath(), readHyperIndexPools(), readHyperIndexState(), V4PoolStateRow, getAllPoolStates(), setHypersyncDefaults() (+1 more)

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
Cohesion: 0.38
Nodes (9): extractGasResult(), inferTokenIdx(), inferZeroForOne(), normalizeProtocol(), simulateHop(), simulateRoute(), SimulationEdge, RouteStateCache (+1 more)

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
Nodes (15): CompatDatabase, CompatStatement, createInMemoryDatabase(), SQLInputValue, applyMigrationV1ToV2(), ensureSchema(), addrCol, colNames (+7 more)

### Community 32 - "Community 32"
Cohesion: 0.09
Nodes (25): BlockField, client, createConfigError(), createHypersyncClient(), createHyperSyncUnavailableError(), createUnavailableHypersyncClientImpl(), Decoder, ensureClient() (+17 more)

### Community 34 - "Community 34"
Cohesion: 0.29
Nodes (5): FACTORY_ABI, fetchCurvePools(), factoryAddress, mockClient, mockFactory

### Community 47 - "Community 47"
Cohesion: 0.29
Nodes (5): BackrunCandidate, Backrunner, BackrunnerOptions, LargeSwapSignal, FoundCycle

### Community 49 - "Community 49"
Cohesion: 0.06
Nodes (68): ActivityLog, getCheckpoint(), saveCheckpoint(), getPoolMeta(), HypersyncDecoderRuntime, WATCHER_SIGNATURES, buildHandlerMap(), dispatchLog() (+60 more)

### Community 50 - "Community 50"
Cohesion: 0.22
Nodes (8): EvmAddress, isEvmAddress(), isFastEvmAddress(), isPolygonSystemContract(), normalizeEvmAddress(), normalizeProtocolKey(), POLYGON_SYSTEM_PREFIXES, ProtocolKey

### Community 51 - "Community 51"
Cohesion: 0.12
Nodes (30): createActivityLog(), createBotState(), main(), age(), BotActivityProgress, BotOpportunityRow, BotState, fmt() (+22 more)

### Community 52 - "Community 52"
Cohesion: 0.22
Nodes (8): abiDir, __dirname, effectDir, __filename, handlerDir, HYPERINDEX_DIR, procPath, readerPath

### Community 53 - "Community 53"
Cohesion: 0.10
Nodes (24): computeProfit(), ComputeProfitOptions, gasCostMaticWei(), invalidAssessment(), maticWeiToTokens(), roiMicroUnits(), baseOpts, r2 (+16 more)

### Community 54 - "Community 54"
Cohesion: 0.08
Nodes (15): clampPriorityFee(), DEFAULT_GAS_CONFIG, FeeSnapshot, GasOracle, GasOracleConfig, PolygonGasHints, scalePriorityFeeByProfitMargin(), fetchGas (+7 more)

### Community 55 - "Community 55"
Cohesion: 0.14
Nodes (6): DecodedSwap, decodeSwapCalldata(), SELECTORS, DEFAULT_MEMPOOL_OPTIONS, MempoolService, MempoolServiceOptions

### Community 56 - "Community 56"
Cohesion: 0.09
Nodes (21): compilerOptions, esModuleInterop, module, moduleResolution, outDir, strict, target, include (+13 more)

### Community 57 - "Community 57"
Cohesion: 0.17
Nodes (11): DecodedPoolEvent, TokenMetaFetcher, TokenMetaRemote, DiscoveryResult, DiscoveryServiceDeps, V2FactoryConfig, fetchV2Pools(), V2_FACTORY_ABI (+3 more)

### Community 58 - "Community 58"
Cohesion: 0.09
Nodes (12): AttemptEntry, AttemptLogSink, logAttempt(), sinks, BuiltTransaction, AlchemyPrivateTxSubmitter, hostnameFromUrl(), PrivateRelaySubmitter (+4 more)

### Community 59 - "Community 59"
Cohesion: 0.21
Nodes (10): childLogger(), createLogSinkStream(), createRootLogger(), LEVEL_LABELS, LoggerOptions, dependencies, @envio-dev/hypersync-client, pino (+2 more)

### Community 60 - "Community 60"
Cohesion: 0.36
Nodes (11): CandidateExecution, RuntimeContext, buildCandidate(), getGasPriceWei(), runPassLoop(), sleep(), weiToGwei(), withTimeout() (+3 more)

### Community 62 - "Community 62"
Cohesion: 0.21
Nodes (8): DEFAULT_WARMUP_OPTIONS, PoolStateFetcher, syncBatch(), pool, USDC, WETH, WarmupOptions, warmupStateCache()

### Community 63 - "Community 63"
Cohesion: 0.83
Nodes (3): extractReserves(), poolLiquidityWmatic(), toBigintOrUndefined()

### Community 66 - "Community 66"
Cohesion: 0.17
Nodes (20): normalizeAddressForDb(), parseJson(), poolMetaRowToObject(), poolRowToObject(), PROTOCOL_BIGINT_ARRAY_FIELDS, PROTOCOL_BIGINT_SCALAR_FIELDS, protocolClass(), rehydrateStateData() (+12 more)

### Community 67 - "Community 67"
Cohesion: 0.15
Nodes (12): A, B, cache, edge, edges, p1, p2, poolA (+4 more)

### Community 68 - "Community 68"
Cohesion: 0.21
Nodes (13): decodeCurvePoolAdded(), decodePairCreated(), decodePoolDeployed(), decodePoolRegistered(), extractAddress(), extractAddressFromTopic(), PROTOCOL_BALANCER, PROTOCOL_CURVE (+5 more)

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (5): code:typescript (<<<<), code:bash (git add .), Task 1: Fix WatcherService Drain, Task 2: Final Verification & Commit, Workspace Repair Implementation Plan

### Community 75 - "Community 75"
Cohesion: 0.33
Nodes (4): DEFAULT_WEIGHTS, rankRoutes(), ScoringWeights, EvaluatedRoute

### Community 76 - "Community 76"
Cohesion: 0.23
Nodes (10): MOCK_BUILD_ARB_TX_RETURN, mockContext, mockExecute, mockProfitable, mockStateUpdate, enumerateCycles(), feeLogWeight(), find2HopCycles() (+2 more)

### Community 80 - "Community 80"
Cohesion: 0.18
Nodes (4): FlashLoanQuote, LiquidityChecker, RpcClientForLiquidity, FlashLoanSource

### Community 83 - "Community 83"
Cohesion: 0.25
Nodes (3): HydrationService, PoolStateFetcher, StateCache

### Community 98 - "Community 98"
Cohesion: 0.40
Nodes (4): BALANCER_ABI, client, fetchBalancerMetadata, VAULT_ABI

### Community 99 - "Community 99"
Cohesion: 0.50
Nodes (3): client, CURVE_ABI, fetchCurveMetadata

### Community 100 - "Community 100"
Cohesion: 0.50
Nodes (3): client, ERC20_ABI, fetchTokenDecimals

### Community 103 - "Community 103"
Cohesion: 0.25
Nodes (8): code:json ([), code:json ([), code:bash (git add hyperindex/abis/), code:json ([), code:json ([), code:json ([), code:json ([), Task 2: Create ABI JSON files

### Community 104 - "Community 104"
Cohesion: 0.29
Nodes (6): code:block1 (hyperindex/), code:json ({), code:bash (git add package.json), File Structure, HyperIndex Ingestion Layer Implementation Plan, Task 14: Switch to Bun runtime

### Community 106 - "Community 106"
Cohesion: 0.33
Nodes (6): code:typescript (// In boot.ts, add after the DB initialization:), code:typescript (const getPools = (): PoolMeta[] => {), code:typescript (// At the top of pass_loop.ts or as a helper), code:typescript (// Remove these lines:), code:bash (git add src/orchestrator/boot.ts src/orchestrator/pass_loop.), Task 12: Integrate pass loop with HyperIndex DB

### Community 107 - "Community 107"
Cohesion: 0.40
Nodes (5): code:json ({), code:json ({), code:block4 (node_modules/), code:bash (git add hyperindex/package.json hyperindex/tsconfig.json hyp), Task 1: Create HyperIndex project scaffolding

### Community 108 - "Community 108"
Cohesion: 0.40
Nodes (5): code:typescript (import { createEffect, S } from "envio";), code:typescript (import { createEffect, S } from "envio";), code:typescript (import { createEffect, S } from "envio";), code:bash (git add hyperindex/src/effects/), Task 11: Write createEffect functions

### Community 109 - "Community 109"
Cohesion: 0.40
Nodes (5): code:typescript (import { spawn, type ChildProcess } from "child_process";), code:typescript (// In main.ts boot sequence:), code:block44 (hyperindex/.hyperindex/), code:bash (git add src/cli/main.ts), Task 15: End-to-end integration test

### Community 110 - "Community 110"
Cohesion: 0.67
Nodes (3): code:yaml (name: arb_bot_ingestion), code:bash (git add hyperindex/config.yaml), Task 3: Create config.yaml

### Community 111 - "Community 111"
Cohesion: 0.67
Nodes (3): code:graphql (type PoolMeta {), code:bash (git add hyperindex/schema.graphql), Task 4: Create schema.graphql

### Community 112 - "Community 112"
Cohesion: 0.67
Nodes (3): code:typescript (import { indexer } from "envio";), code:bash (git add hyperindex/src/handlers/v2_factory.ts), Task 5: Write V2 factory handler (contractRegister)

### Community 113 - "Community 113"
Cohesion: 0.67
Nodes (3): code:typescript (import { indexer } from "envio";), code:bash (git add hyperindex/src/handlers/v2_pool.ts), Task 6: Write V2 pool handler (Sync/Swap → state)

### Community 114 - "Community 114"
Cohesion: 0.67
Nodes (3): code:typescript (import { indexer } from "envio";), code:bash (git add hyperindex/src/handlers/v3_factory.ts), Task 7: Write V3 factory handler (contractRegister)

### Community 115 - "Community 115"
Cohesion: 0.67
Nodes (3): code:typescript (import { indexer } from "envio";), code:bash (git add hyperindex/src/handlers/v3_pool.ts), Task 8: Write V3 pool handler (Swap → state)

### Community 116 - "Community 116"
Cohesion: 0.67
Nodes (3): code:typescript (import { indexer } from "envio";), code:bash (git add hyperindex/src/handlers/curve_factory.ts), Task 9: Write Curve factory handler

### Community 117 - "Community 117"
Cohesion: 0.67
Nodes (3): code:typescript (import { indexer } from "envio";), code:bash (git add hyperindex/src/handlers/curve_pool.ts), Task 10: Write Curve pool handler

### Community 118 - "Community 118"
Cohesion: 0.67
Nodes (3): code:bash (git rm -r src/services/discovery/), code:bash (git add -A), Task 13: Clean up old services

### Community 127 - "Community 127"
Cohesion: 0.17
Nodes (12): optimizeInputAmount(), OptimizeOptions, mkResult(), result, simulate(), ArbPath, CycleEnumerationOptions, RouteEdge (+4 more)

### Community 128 - "Community 128"
Cohesion: 0.60
Nodes (4): decodePoolCreated(), discoverV3Pools(), extractAddress(), V3PoolInfo

### Community 129 - "Community 129"
Cohesion: 0.50
Nodes (3): currency0, currency1, poolId

## Knowledge Gaps
- **570 isolated node(s):** `__filename`, `__dirname`, `HYPERINDEX_DIR`, `abiDir`, `handlerDir` (+565 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createRootLogger()` connect `Community 59` to `Community 49`, `Community 51`, `Community 22`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Community 59` to `Community 0`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **What connects `__filename`, `__dirname`, `HYPERINDEX_DIR` to the rest of the system?**
  _570 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.04625346901017576 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.058029689608636977 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.06968641114982578 - nodes in this community are weakly interconnected._