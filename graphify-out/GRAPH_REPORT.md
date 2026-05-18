# Graph Report - t  (2026-05-18)

## Corpus Check
- 152 files · ~51,188 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 400 nodes · 469 edges · 51 communities (35 shown, 16 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6ffa04de`
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
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]

## God Nodes (most connected - your core abstractions)
1. `pollLoop()` - 9 edges
2. `scripts` - 8 edges
3. `updateV3LiquidityState()` - 7 edges
4. `Architecture` - 7 edges
5. `createHypersyncClient()` - 6 edges
6. `WatcherService` - 6 edges
7. `updateV2State()` - 6 edges
8. `createHyperSyncUnavailableError()` - 5 edges
9. `dispatchLog()` - 5 edges
10. `checkReorg()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `pollLoop()` --calls--> `signal`  [INFERRED]
  src/services/watcher/poll_loop.ts → src/services/strategy/backrunner.test.ts
- `pollLoop()` --calls--> `checkReorg()`  [EXTRACTED]
  src/services/watcher/poll_loop.ts → src/services/watcher/reorg.ts
- `pollLoop()` --calls--> `commitWatcherStatesBatch()`  [EXTRACTED]
  src/services/watcher/poll_loop.ts → src/services/watcher/state_ops.ts
- `pollLoop()` --calls--> `dispatchLog()`  [EXTRACTED]
  src/services/watcher/poll_loop.ts → src/services/watcher/log_handler.ts

## Communities (51 total, 16 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (31): dependencies, @envio-dev/hypersync-client, pino, tsx, viem, zod, devDependencies, eslint (+23 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (16): Architecture, CLI (`src/cli/`), code:block1 (git clone <repo>), code:block2 (pnpm start), Config (`src/config/`), Configuration, Core (`src/core/`), Development (+8 more)

### Community 2 - "Community 2"
Cohesion: 0.16
Nodes (27): asStateRecord(), commitWatcherStatesBatch(), CORE_STATE_KEYS, decodedBigInt(), decodedValue(), ensureV3Fee(), isTickRecord(), mergeStateIntoCache() (+19 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (37): log, r, BlockField, createConfigError(), createHypersyncClient(), createHyperSyncUnavailableError(), createUnavailableHypersyncClientImpl(), ensureClient() (+29 more)

### Community 5 - "Community 5"
Cohesion: 0.14
Nodes (13): baseState, cycle, edge1, edge2, enumerateFn, options, POOL_A, POOL_B (+5 more)

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
Cohesion: 0.33
Nodes (7): checkReorg(), detectReorg(), pick(), ReorgResult, RollbackGuard, rollbackToBlock(), storedRollbackGuard()

### Community 14 - "Community 14"
Cohesion: 0.25
Nodes (7): bigUint20, bigUint40, out, out1, out2, result, state

### Community 15 - "Community 15"
Cohesion: 0.25
Nodes (7): graph, hubTokens, pool, pool1, pool2, state, stateMap

### Community 16 - "Community 16"
Cohesion: 0.29
Nodes (6): fetchGas, first, oracle, scaled, second, snap

### Community 17 - "Community 17"
Cohesion: 0.29
Nodes (5): mockGet, mockGetHeight, MockHypersyncClient, mockRecv, mockStream

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
Cohesion: 0.40
Nodes (4): c, g, h, rendered

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

### Community 49 - "Community 49"
Cohesion: 0.11
Nodes (30): client, Decoder, HypersyncDecoderRuntime, signal, buildHandlerMap(), dispatchLog(), getHandler(), getHandlerMap() (+22 more)

## Knowledge Gaps
- **237 isolated node(s):** `Logger`, `LoggerOptions`, `name`, `version`, `type` (+232 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `pollLoop()` connect `Community 49` to `Community 2`, `Community 20`, `Community 13`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `signal` connect `Community 49` to `Community 5`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `WatcherService` connect `Community 20` to `Community 49`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **What connects `Logger`, `LoggerOptions`, `name` to the rest of the system?**
  _237 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.11764705882352941 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.06201550387596899 - nodes in this community are weakly interconnected._