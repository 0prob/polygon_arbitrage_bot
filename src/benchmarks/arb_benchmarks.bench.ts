import { describe, bench, beforeAll } from "vitest";
import { buildGraph } from "../services/strategy/graph.ts";
import { enumerateCycles } from "../services/strategy/finder.ts";
import { RouteCache } from "../services/strategy/cache.ts";
import { GasOracle, DEFAULT_GAS_CONFIG } from "../services/execution/gas.ts";
import { evaluatePipeline } from "../services/strategy/pipeline.ts";
import { simulateRoute } from "../services/strategy/simulator.ts";
import type { Address } from "../core/types/common.ts";
import type { PoolMeta } from "../core/types/pool.ts";
import type { SwapEdge, RoutingGraph } from "../services/strategy/graph.ts";
import type { FoundCycle } from "../services/strategy/finder.ts";
import type { RouteStateCache } from "../core/types/route.ts";

// ─── Helpers ──────────────────────────────────────────────────

function addr(n: number): Address {
  return `0x${n.toString(16).padStart(40, "0")}` as Address;
}

function makePool(id: number, tokenCount: number): PoolMeta {
  const t0 = addr(id % tokenCount);
  const t1 = addr((id + 1) % tokenCount);
  return {
    address: addr(id),
    protocol: "V2",
    token0: t0,
    token1: t1,
    tokens: [t0, t1],
    fee: 30,
    status: "active",
  };
}

function makeState(pool: PoolMeta, tokenCount: number): Record<string, unknown> {
  const base = BigInt(pool.fee) * 100_000n;
  return {
    reserve0: base,
    reserve1: base * 10n,
    token0: pool.token0,
    token1: pool.token1,
    tokens: pool.tokens,
    fee: 30n,
  };
}

// ─── Suite 1: Cycle Enumeration ──────────────────────────────

describe("Cycle enumeration", () => {
  let graph: RoutingGraph;

  beforeAll(() => {
    const poolCount = 100;
    const pools: PoolMeta[] = [];
    for (let i = 0; i < poolCount; i++) {
      pools.push(makePool(i, 100));
    }
    graph = buildGraph(pools, new Map());
  });

  bench("100 tokens, 2% connectivity, maxHops=2", () => {
    enumerateCycles(graph, 2);
  });
});

// ─── Suite 2: Cache Throughput ───────────────────────────────

describe("Cache throughput", () => {
  let cache: RouteCache;
  const CACHE_SIZE = 1000;
  const allPoolAddresses: string[] = [];

  beforeAll(() => {
    cache = new RouteCache(CACHE_SIZE);
    const edgePool: string[] = [];
    for (let i = 0; i < CACHE_SIZE; i++) {
      const a = addr(2 * i);
      const b = addr(2 * i + 1);
      const edges: SwapEdge[] = [
        { poolAddress: addr(2 * i), protocol: "V2", tokenIn: a, tokenOut: b, feeBps: 30n },
        { poolAddress: addr(2 * i + 1), protocol: "V2", tokenIn: b, tokenOut: a, feeBps: 30n },
      ];
      edgePool.push(addr(2 * i).toLowerCase());
      edgePool.push(addr(2 * i + 1).toLowerCase());
      const cycle: FoundCycle = {
        startToken: a,
        edges,
        hopCount: 2,
        logWeight: 0,
        cumulativeFeeBps: 30n,
      };
      cache.update([{ path: cycle, profit: BigInt(i * 10) }]);
    }
    allPoolAddresses.push(...edgePool);
  });

  bench("random getByPools across 1000 entries", () => {
    const idx = Math.floor(Math.random() * allPoolAddresses.length);
    cache.getByPools(new Set([allPoolAddresses[idx]]));
  });
});

// ─── Suite 3: Gas Oracle Refresh ─────────────────────────────

describe("Gas oracle refresh", () => {
  let oracle: GasOracle;
  const FETCH_COUNT = 100;

  beforeAll(() => {
    let callCount = 0;
    oracle = new GasOracle(DEFAULT_GAS_CONFIG, () =>
      Promise.resolve({
        baseFee: (30n + BigInt(callCount++ % 10)) * 10n ** 9n,
        priorityFee: 30n * 10n ** 9n,
      }),
    );
  });

  bench("refresh mock fee data (start + snapshot + stop)", async () => {
    oracle.stop();
    await oracle.start();
    oracle.getSnapshot();
    oracle.stop();
  });
});

// ─── Suite 4: Pipeline Throughput ────────────────────────────

describe("Pipeline throughput", () => {
  const POOL_COUNT = 100;
  let cycles: FoundCycle[];
  let stateCache: RouteStateCache;

  beforeAll(() => {
    const pools: PoolMeta[] = [];
    const stateMap = new Map<string, unknown>();
    for (let i = 0; i < POOL_COUNT; i++) {
      const pool = makePool(i, 100);
      pools.push(pool);
      stateMap.set(pool.address.toLowerCase(), makeState(pool, 100));
    }

    const graph = buildGraph(pools, stateMap);
    cycles = enumerateCycles(graph, 2);
    stateCache = stateMap as RouteStateCache;
  });

  bench("synthetic 2-hop cycles + state simulation", () => {
    for (const cycle of cycles) {
      try {
        simulateRoute(cycle.edges, 10n ** 18n, stateCache);
      } catch {
        // skip edges without simulation support
      }
    }
  });
});
