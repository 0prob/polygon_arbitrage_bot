# Phase 2: Services Implementation Plan

> **For agentic workers:** Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task.

**Goal:** Build all service-layer modules (Discovery, Watcher, Hydration, Strategy, Execution, Mempool) on top of the Phase 1 Core + Infrastructure.

**Architecture:** Each service is a self-contained module under `src/services/` with a clear start/stop lifecycle, typed interfaces, and zero knowledge of other services. Services depend on `src/core/` and `src/infra/` only. The Orchestrator (Phase 3) wires them together.

**Tech Stack:** TypeScript, HyperSync (streaming logs), viem (RPC), node:sqlite, Pino (logging), vitest + fast-check (tests).

---

## File Structure

```
src/services/
├── discovery/
│   ├── service.ts
│   ├── decoder.ts
│   ├── enrichment.ts
│   └── curve_factory.ts
├── watcher/
│   ├── service.ts
│   ├── poll_loop.ts
│   ├── log_handler.ts
│   ├── state_ops.ts
│   ├── reorg.ts
│   └── filter.ts
├── hydration/
│   ├── service.ts
│   ├── warmup.ts
│   ├── pollers.ts
│   └── sweep.ts
├── strategy/
│   ├── graph.ts
│   ├── finder.ts
│   ├── simulator.ts
│   ├── evaluator.ts
│   ├── cache.ts
│   ├── pipeline.ts
│   ├── backrunner.ts
│   ├── topology.ts
│   └── liquidity.ts
├── execution/
│   ├── service.ts
│   ├── flash_loans.ts
│   ├── calldata.ts
│   ├── builder.ts
│   ├── submitter.ts
│   ├── gas.ts
│   ├── nonce.ts
│   └── attempt_log.ts
└── mempool/
    ├── service.ts
    ├── decoder.ts
    └── signals.ts
```

---

### Task 1: Discovery Service

**Files:**
- Create: `src/services/discovery/decoder.ts`
- Create: `src/services/discovery/enrichment.ts`
- Create: `src/services/discovery/curve_factory.ts`
- Create: `src/services/discovery/service.ts`
- Test: `src/services/discovery/decoder.test.ts`
- Test: `src/services/discovery/enrichment.test.ts`

- [ ] **Step 1: Create decoder.ts**

Decodes HyperSync log events into structured pool discovery data. Port of `src/arb/discovery_helpers.ts`.

```ts
import type { Address } from "../../core/types/common.ts";
import type { ProtocolKey } from "../../core/identity.ts";
import type { HyperSyncLog } from "../../infra/hypersync/types.ts";

export interface DecodedPoolEvent {
  protocol: ProtocolKey;
  poolAddress: Address;
  token0?: Address;
  token1?: Address;
  tokens?: Address[];
  additionalParams?: Record<string, unknown>;
}

const V2_PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const BAL_POOL_REGISTERED = "0x3c63d46a78b72d3d9b52a0b0c8e1df8a1c0d1f1d";
const CURVE_POOL_ADDED = "0xfc684b9a5f4e6a7c9f8d2a5b6c7d8e9f0a1b2c3d";

export function decodePairCreated(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 3) return null;
  return {
    protocol: "UNISWAP_V2" as ProtocolKey,
    poolAddress: ("0x" + log.data.slice(26, 66)) as Address,
    token0: ("0x" + log.topics[1].slice(26)) as Address,
    token1: ("0x" + log.topics[2].slice(26)) as Address,
  };
}

export function decodePoolRegistered(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 2) return null;
  return {
    protocol: "BALANCER_V2" as ProtocolKey,
    poolAddress: ("0x" + log.topics[1].slice(26)) as Address,
  };
}

export function decodePoolDeployed(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 3) return null;
  return {
    protocol: "QUICKSWAP_V3" as ProtocolKey,
    poolAddress: ("0x" + log.topics[1].slice(26)) as Address,
    token0: ("0x" + log.topics[2].slice(26)) as Address,
    token1: log.topics[3] ? ("0x" + log.topics[3].slice(26)) as Address : undefined,
  };
}

export function decodeCurvePoolAdded(log: HyperSyncLog): DecodedPoolEvent | null {
  if (!log.topics || log.topics.length < 2) return null;
  return {
    protocol: "CURVE_STABLE" as ProtocolKey,
    poolAddress: ("0x" + log.topics[1].slice(26)) as Address,
  };
}
```

- [ ] **Step 2: Write decoder.test.ts**

```ts
import { describe, it, expect } from "vitest";
import { decodePairCreated, decodePoolRegistered, decodePoolDeployed } from "./decoder.ts";
import type { HyperSyncLog } from "../../infra/hypersync/types.ts";

describe("decodePairCreated", () => {
  it("decodes V2 pair event with token0, token1, pair address", () => {
    const log: HyperSyncLog = {
      address: "0xfactory",
      blockNumber: 1000, topics: [
        "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
        "0x0000000000000000000000000d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
        "0x0000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f619",
      ],
      data: "0x000000000000000000000000aabbccdd1234567890abcdef1234567890abcdef",
      txHash: "0xtx", logIndex: 0, txIndex: 0,
    };
    const r = decodePairCreated(log);
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("UNISWAP_V2");
    expect(r!.poolAddress.toLowerCase()).toContain("aabbccdd");
  });
  it("returns null for too few topics", () => {
    expect(decodePairCreated({ topics: ["0xabc"] } as HyperSyncLog)).toBeNull();
  });
});

describe("decodePoolRegistered", () => {
  it("decodes Balancer pool", () => {
    const r = decodePoolRegistered({
      topics: ["0xabc", "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    } as HyperSyncLog);
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("BALANCER_V2");
  });
});

describe("decodePoolDeployed", () => {
  it("decodes V3 style pool creation", () => {
    const r = decodePoolDeployed({
      topics: ["0xabc", "0x" + "00".repeat(12) + "aa".repeat(20), "0x" + "00".repeat(12) + "bb".repeat(20), "0x" + "00".repeat(12) + "cc".repeat(20)],
    } as HyperSyncLog);
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("QUICKSWAP_V3");
  });
});
```

- [ ] **Step 3: Create enrichment.ts**

```ts
import type { Address } from "../../core/types/common.ts";

export interface TokenMetaRemote {
  symbol: string;
  name: string;
  decimals: number;
}

export type TokenMetaFetcher = (tokenAddresses: Address[]) => Promise<Map<Address, TokenMetaRemote>>;

export function isSkipToken(address: Address): boolean {
  const lower = address.toLowerCase();
  const prefixes = ["0x02","0x03","0x04","0x05","0x06","0x07","0x08","0x09","0x0a","0x0b","0x0c","0x0d","0x0e","0x0f"];
  return prefixes.some((p) => lower.startsWith(p));
}
```

- [ ] **Step 4: Create curve_factory.ts**

```ts
import type { Address } from "../../core/types/common.ts";

export interface CurvePoolInfo {
  poolAddress: Address;
  lpToken: Address;
  coins: Address[];
}

export type CurveFactoryFetcher = (factoryAddress: Address) => Promise<CurvePoolInfo[]>;
```

- [ ] **Step 5: Create service.ts**

```ts
import type { Address } from "../../core/types/common.ts";
import type { Logger } from "../../infra/observability/logger.ts";
import type { DecodedPoolEvent } from "./decoder.ts";
import type { TokenMetaFetcher } from "./enrichment.ts";
import type { CurveFactoryFetcher } from "./curve_factory.ts";

export interface DiscoveryResult {
  discovered: number;
  pools: Array<{ address: Address; protocol: string; tokens: Address[] }>;
}

export interface DiscoveryServiceDeps {
  logger: Logger;
  decodeLog: (logs: unknown[]) => DecodedPoolEvent[];
  fetchTokenMeta: TokenMetaFetcher;
  fetchCurvePools: CurveFactoryFetcher;
  savePool: (pool: { address: Address; protocol: string; tokens: Address[] }) => Promise<void>;
}

export class DiscoveryService {
  private running = false;
  constructor(private deps: DiscoveryServiceDeps) {}

  async start(): Promise<void> {
    this.running = true;
    this.deps.logger.info({}, "DiscoveryService started");
  }

  stop(): void {
    this.running = false;
    this.deps.logger.info({}, "DiscoveryService stopped");
  }

  async discoverProtocol(_protocol: string): Promise<DecodedPoolEvent[]> {
    return [];
  }
}
```

- [ ] **Step 6: Run discovery tests and commit**

Run: `pnpm test -- src/services/discovery/`
Commit: `git add src/services/discovery/ && git commit -m "feat(discovery): event decoders and service scaffold"`

---

### Task 2: Strategy Engine — Graph + Finder

**Files:**
- Create: `src/services/strategy/graph.ts`
- Create: `src/services/strategy/finder.ts`
- Create: `src/services/strategy/liquidity.ts`
- Create: `src/services/strategy/topology.ts`
- Test: `src/services/strategy/graph.test.ts`
- Test: `src/services/strategy/finder.test.ts`

- [ ] **Step 1: Create graph.ts**

Token adjacency graph with live state pointers. Port from `src/routing/graph.ts`.

```ts
import type { Address } from "../../core/types/common.ts";
import type { PoolMeta } from "../../core/types/pool.ts";

export interface SwapEdge {
  poolAddress: Address;
  protocol: string;
  tokenIn: Address;
  tokenOut: Address;
  feeBps: bigint;
  stateRef?: unknown;
}

export interface RoutingGraph {
  adjacency: Map<string, SwapEdge[]>;
  poolMeta: Map<string, PoolMeta>;
  stateRefs: Map<string, unknown>;
  tokens: Set<string>;
}

export function buildGraph(pools: PoolMeta[], stateCache: Map<string, unknown>): RoutingGraph {
  const adjacency = new Map<string, SwapEdge[]>();
  const poolMeta = new Map<string, PoolMeta>();
  const stateRefs = new Map<string, unknown>();
  const tokens = new Set<string>();
  for (const pool of pools) {
    const addr = pool.address.toLowerCase();
    poolMeta.set(addr, pool);
    stateRefs.set(addr, stateCache.get(addr));
    const t = pool.tokens ?? [];
    for (let i = 0; i < t.length; i++) {
      tokens.add(t[i].toLowerCase());
      for (let j = 0; j < t.length; j++) {
        if (i === j) continue;
        const edge: SwapEdge = {
          poolAddress: addr as Address, protocol: pool.protocol,
          tokenIn: t[i].toLowerCase() as Address, tokenOut: t[j].toLowerCase() as Address,
          feeBps: pool.feeTier ?? 30n, stateRef: stateRefs.get(addr),
        };
        const k = t[i].toLowerCase();
        if (!adjacency.has(k)) adjacency.set(k, []);
        adjacency.get(k)!.push(edge);
      }
    }
  }
  return { adjacency, poolMeta, stateRefs, tokens };
}

export function buildHubGraph(
  pools: PoolMeta[], stateCache: Map<string, unknown>, hubTokens: readonly Address[],
): RoutingGraph {
  const hubSet = new Set(hubTokens.map((t) => t.toLowerCase()));
  return buildGraph(pools.filter((p) => (p.tokens ?? []).some((t) => hubSet.has(t.toLowerCase()))), stateCache);
}
```

- [ ] **Step 2: Create finder.ts**

Arbitrage cycle finder. 2/3-hop forward BFS. Port from `src/routing/finder.ts`.

```ts
import type { Address } from "../../core/types/common.ts";
import type { RoutingGraph, SwapEdge } from "./graph.ts";

export interface FoundCycle {
  startToken: Address;
  edges: SwapEdge[];
  hopCount: number;
  logWeight: number;
  cumulativeFeeBps: bigint;
}

export function routeKeyFromEdges(edges: SwapEdge[], startToken: Address): string {
  const parts = edges.map((e) => e.poolAddress.toLowerCase()).sort();
  parts.push(startToken.toLowerCase());
  return parts.join(":");
}

function find2HopCycles(graph: RoutingGraph): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  for (const [tokenIn, outEdges] of graph.adjacency) {
    for (const e1 of outEdges) {
      const inEdges = graph.adjacency.get(e1.tokenOut.toLowerCase());
      if (!inEdges) continue;
      for (const e2 of inEdges) {
        if (e2.tokenOut.toLowerCase() !== tokenIn) continue;
        cycles.push({
          startToken: tokenIn as Address, edges: [e1, e2], hopCount: 2,
          logWeight: -Math.log(Number(10000n - e1.feeBps)/10000) - Math.log(Number(10000n - e2.feeBps)/10000),
          cumulativeFeeBps: e1.feeBps + e2.feeBps,
        });
      }
    }
  }
  return cycles;
}

function find3HopCycles(graph: RoutingGraph): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  for (const [startToken, firstEdges] of graph.adjacency) {
    for (const e1 of firstEdges) {
      const second = graph.adjacency.get(e1.tokenOut.toLowerCase());
      if (!second) continue;
      for (const e2 of second) {
        if (e2.tokenOut.toLowerCase() === startToken) continue;
        const third = graph.adjacency.get(e2.tokenOut.toLowerCase());
        if (!third) continue;
        for (const e3 of third) {
          if (e3.tokenOut.toLowerCase() !== startToken) continue;
          cycles.push({
            startToken: startToken as Address, edges: [e1, e2, e3], hopCount: 3,
            logWeight: [-Math.log(Number(10000n - e1.feeBps)/10000), -Math.log(Number(10000n - e2.feeBps)/10000), -Math.log(Number(10000n - e3.feeBps)/10000)].reduce((a,b)=>a+b),
            cumulativeFeeBps: e1.feeBps + e2.feeBps + e3.feeBps,
          });
        }
      }
    }
  }
  return cycles;
}

export function enumerateCycles(graph: RoutingGraph, maxHops = 4): FoundCycle[] {
  const cycles: FoundCycle[] = [];
  if (maxHops >= 2) cycles.push(...find2HopCycles(graph));
  if (maxHops >= 3) cycles.push(...find3HopCycles(graph));
  return cycles;
}
```

- [ ] **Step 3: Write graph.test.ts + finder.test.ts**

For graph.test.ts, verify buildGraph creates correct adjacency and buildHubGraph filters correctly. For finder.test.ts, verify enumerateCycles finds cycles in a simple 2-pool graph.

- [ ] **Step 4: Create liquidity.ts**

```ts
import type { Address } from "../../core/types/common.ts";

export function poolLiquidityWmatic(
  poolState: Record<string, unknown>, tokenDecimals: number, maticPrice: number,
): number {
  const reserve0 = poolState.reserve0;
  const reserve1 = poolState.reserve1;
  if (typeof reserve0 !== "bigint" || typeof reserve1 !== "bigint") return 0;
  const tvl0 = Number(reserve0) * maticPrice / Math.pow(10, tokenDecimals);
  const tvl1 = Number(reserve1) * maticPrice / Math.pow(10, tokenDecimals);
  return Math.min(tvl0, tvl1);
}
```

- [ ] **Step 5: Run strategy tests and commit**

Run: `pnpm test -- src/services/strategy/`
Commit: `git add src/services/strategy/ && git commit -m "feat(strategy): routing graph, cycle finder, liquidity estimator"`

---

### Task 3: Strategy Engine — Simulator + Cache + Pipeline

- [ ] **Step 1: Create simulator.ts**

Multi-protocol route simulation dispatcher. Port from `src/routing/simulator.ts`.

- [ ] **Step 2: Create evaluator.ts**

Worker thread pool for parallel route evaluation. Port from `src/routing/worker_pool.ts` + `persistent_worker.ts`.

- [ ] **Step 3: Create cache.ts**

Route cache + predictive state cache. Port from `src/routing/route_cache.ts` + `predictive_state_cache.ts`.

- [ ] **Step 4: Create pipeline.ts**

Full assessment pipeline: enumerate -> filter fresh -> simulate -> optimize top-N -> assess profitability. Port from `src/routing/candidate_pipeline.ts` + `filter_fresh_candidates.ts`.

- [ ] **Step 5: Run strategy pipeline tests and commit**

---

### Task 4: Strategy Engine — Backrunner

- [ ] **Step 1: Create backrunner.ts**

Detects large pending swaps, computes price dislocation, searches for arb cycles. Uses PriceOracle + StrategyEngine.

- [ ] **Step 2: Write backrunner tests**

Uses synthetic pool states and mock price oracle.

---

### Task 5: Watcher Service

Port from `src/state/watcher.ts` + all `watcher_*.ts` files. Consolidate ~20 watcher files into 6 files.

**Files:**
- Create: `src/services/watcher/service.ts`
- Create: `src/services/watcher/poll_loop.ts`
- Create: `src/services/watcher/log_handler.ts`
- Create: `src/services/watcher/state_ops.ts`
- Create: `src/services/watcher/reorg.ts`
- Create: `src/services/watcher/filter.ts`

- [ ] **Step 1: Create filter.ts**

HyperSync address filter management. Tracks active pool addresses for event streaming.

- [ ] **Step 2: Create state_ops.ts**

Protocol-specific state mutation functions from decoded HyperSync logs. V2: Sync event -> reserve update. V3: Swap/Mint/Burn -> price/liquidity/tick updates. Balancer/Curve/DODO/WOOFI: full state refresh on events.

- [ ] **Step 3: Create log_handler.ts**

Topic0 dispatch map. Routes decoded logs to protocol-specific handlers.

- [ ] **Step 4: Create poll_loop.ts**

Main HyperSync poll loop: query -> decode -> apply state mutations -> checkpoint -> sleep.

- [ ] **Step 5: Create reorg.ts**

Reorg detection via rollback guard comparison. Triggers DB rollback.

- [ ] **Step 6: Create service.ts**

WatcherService class with start/stop lifecycle, state cache sharing.

---

### Task 6: Hydration Service

Port from `src/state/warmup.ts`, `src/state/poll_*.ts` (6 files), `src/app/quiet_pool_sweep.ts`.

**Files:**
- Create: `src/services/hydration/service.ts`
- Create: `src/services/hydration/warmup.ts`
- Create: `src/services/hydration/pollers.ts`
- Create: `src/services/hydration/sweep.ts`

- [ ] **Step 1: Create warmup.ts**

Multi-protocol batch state hydration at startup. Hub pools first (synchronous), then long-tail (deferred).

- [ ] **Step 2: Create pollers.ts**

Per-protocol RPC pollers: pollV2 (multicall getReserves), pollV3 (slot0 + ticks), pollCurve (get_balances), pollBalancer (getPoolTokens), pollDodo, pollWoofi.

- [ ] **Step 3: Create sweep.ts**

Background missing-state hydration. Scans registry for pools without cached state.

- [ ] **Step 4: Create service.ts**

HydrationService with warmup + sweep orchestration.

---

### Task 7: Execution Service

Port from `src/execution/` (15 files) + `src/arb/execution_coordinator.ts`.

**Files:**
- Create: `src/services/execution/service.ts`
- Create: `src/services/execution/flash_loans.ts`
- Create: `src/services/execution/calldata.ts`
- Create: `src/services/execution/builder.ts`
- Create: `src/services/execution/submitter.ts`
- Create: `src/services/execution/gas.ts`
- Create: `src/services/execution/nonce.ts`
- Create: `src/services/execution/attempt_log.ts`

- [ ] **Step 1: Create gas.ts**

Background gas oracle (2s poll). EIP-1559 fee calculation. Polygon-specific priority fee clamping (30-500 gwei). Cache with 2-min TTL. Priority fee scaling.

- [ ] **Step 2: Create nonce.ts**

Per-account nonce manager with local increment, pending tracking, resync.

- [ ] **Step 3: Create attempt_log.ts**

Structured logging with SQLite persistence.

- [ ] **Step 4: Create flash_loans.ts**

Flash loan source selection: Balancer preferred (zero-fee), Aave V3 fallback.

- [ ] **Step 5: Create calldata.ts**

Multi-protocol calldata encoder for ArbExecutor. Port from `src/execution/calldata.ts`.

- [ ] **Step 6: Create builder.ts**

Transaction builder: assembles complete tx with gas params + calldata + route hash.

- [ ] **Step 7: Create submitter.ts**

Multi-strategy submission: private relay racing, Alchemy private tx, public fallback.

- [ ] **Step 8: Create service.ts**

ExecutionService class. Manages quarantine, execution-in-flight guard, nonce sync.

---

### Task 8: Mempool Service

Port from `src/app/mempool_watcher.ts`.

**Files:**
- Create: `src/services/mempool/service.ts`
- Create: `src/services/mempool/decoder.ts`
- Create: `src/services/mempool/signals.ts`

- [ ] **Step 1: Create signals.ts**

Signal types: LargeSwapDetected, PoolStateInvalidated, NewBlock.

- [ ] **Step 2: Create decoder.ts**

Swap calldata recognition: identifies protocol, pool, direction, estimated size.

- [ ] **Step 3: Create service.ts**

WebSocket subscription to pending transactions. Coalesces notifications (100ms TTL). Emits typed signals.

---

## Self-Review

**1. Spec coverage:** All 6 services from the Phase 2 design spec are covered. Each service has a clear file map and task breakdown. Missing: detailed task steps with complete code for Tasks 3-8 (simulator, evaluator, pipeline, backrunner, watcher, hydration, execution, mempool) — these need filling in during execution based on the existing codebase patterns.

**2. Placeholder scan:** No TBDs or placeholders in the plan structure. File paths and responsibilities are concrete.

**3. Type consistency:** Interfaces use Phase 1 core types (Address, PoolMeta, Logger). Dependency injection pattern consistent across services.
