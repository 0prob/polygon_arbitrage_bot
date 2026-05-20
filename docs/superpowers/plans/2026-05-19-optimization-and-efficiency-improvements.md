# Optimization and Efficiency Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce lag, sync times, and unnecessary resource usage by optimizing DB connections, caching expensive calculations, and fixing a critical indexer bug.

**Architecture:** 
- Persistent SQLite connections in the HyperIndex reader.
- Time-based and state-based caching in the main arbitrage loop.
- Pre-calculating structural swap parameters to optimize the simulation hot-path.
- Fixing the state-clobbering bug in the Uniswap V4 event handler.

**Tech Stack:** TypeScript, Bun, SQLite, Envio, Viem.

---

### Task 1: DB Connection Persistence in HyperIndex Reader

**Files:**
- Modify: `src/infra/db/hyperindex_reader.ts`

- [ ] **Step 1: Update `buildStateCacheFromHyperIndex` to reuse connection**

```typescript
// Replace the start of the file with this:
import path from "path";
import { createDatabase, type CompatDatabase } from "./connection.ts";

export function getHiDbPath(dataDir: string): string {
  return path.join(dataDir, "../hyperindex/hyperindex.db");
}

let _hiDb: CompatDatabase | null = null;
let _cachedState: Map<string, Record<string, unknown>> = new Map();
let _lastFetchedBlock: number = -1;

// ...

export function buildStateCacheFromHyperIndex(hiDbPath: string, _addresses: string[]): Map<string, Record<string, unknown>> {
  try {
    if (!_hiDb) {
      _hiDb = createDatabase(hiDbPath);
    }
    const hiDb = _hiDb;

    // Optimization: query for the current "head" block of the indexer
    const checkpointRow = hiDb.prepare("SELECT block_number FROM checkpoint ORDER BY block_number DESC LIMIT 1").get() as { block_number: number } | undefined;
    const currentHead = checkpointRow ? checkpointRow.block_number : 999999999;

    if (currentHead <= _lastFetchedBlock && _cachedState.size > 0) {
      return _cachedState;
    }
    // ... rest of queries ...
    // REMOVE hiDb.close() at the end of the function
    _lastFetchedBlock = currentHead;
  } catch (err) {
    // ...
  }
  return _cachedState;
}
```

- [ ] **Step 2: Verify by running existing tests**

Run: `bun test src/infra/db/schema.test.ts` (assuming it touches reader logic)

- [ ] **Step 3: Commit**

```bash
git add src/infra/db/hyperindex_reader.ts
git commit -m "perf: reuse DB connection in hyperindex reader"
```

---

### Task 2: Fix Uniswap V4 Indexer Swap Handler

**Files:**
- Modify: `hyperindex/src/handlers/v4.ts`

- [ ] **Step 1: Update Swap handler to preserve constant fields**

```typescript
// Modify the Swap event handler:
indexer.onEvent(
  { contract: "PoolManager", event: "Swap" },
  async ({ event, context }: any) => {
    const poolId = event.params.id.toLowerCase();

    // In Envio, we fetch the existing state first if we need to preserve fields, 
    // or we use a partial update if supported. 
    // Since Initialize sets the constants, we only update dynamic fields.
    const existing = await context.V4PoolState.get(poolId);

    context.V4PoolState.set({
      ...existing, // Preserve existing fields like tickSpacing and hooks
      id: poolId,
      address: poolId,
      lastUpdatedBlock: Number(event.block.number),
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: Number(event.params.tick),
      fee: event.params.fee,
    });
  },
);
```

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/v4.ts
git commit -m "fix: preserve V4 pool constants in swap handler"
```

---

### Task 3: Cycle & Gas Price Caching in Pass Loop

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Implement caching logic in `runPassLoop`**

```typescript
// ... inside runPassLoop ...
  let lastPoolCount = 0;
  let cachedCycles: FoundCycle[] = [];
  let lastGasPrice = 0n;
  let lastGasFetchTs = 0;

  while (ctx.isRunning) {
    const startTime = Date.now();
    try {
      const pools = ctx.getPools();
      if (pools.length === 0) { /* ... */ continue; }

      const stateCache = buildStateCacheFromHyperIndex(ctx.hiDbPath, pools.map(p => p.address));
      const graph = buildGraph(pools, stateCache);

      // Cache cycles
      if (pools.length !== lastPoolCount) {
        cachedCycles = enumerateCycles(graph, ctx.config.routing.maxHops);
        lastPoolCount = pools.length;
        ctx.logger.info({ cycles: cachedCycles.length }, "Cycles re-enumerated");
      }
      const cycles = cachedCycles;

      if (cycles.length === 0) { /* ... */ continue; }

      // Cache gas price (1s TTL)
      if (Date.now() - lastGasFetchTs > 1000) {
        lastGasPrice = await getGasPriceWei(ctx);
        lastGasFetchTs = Date.now();
      }
      const gasPriceWei = lastGasPrice;
      // ...
```

- [ ] **Step 2: Run pass loop tests**

Run: `bun test src/orchestrator/pass_loop.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/pass_loop.ts
git commit -m "perf: cache cycles and gas price in pass loop"
```

---

### Task 4: Simulation Hot-path Optimization

**Files:**
- Modify: `src/services/strategy/graph.ts`
- Modify: `src/services/strategy/simulator.ts`
- Modify: `src/services/strategy/finder.ts`

- [ ] **Step 1: Extend `SwapEdge` type**

```typescript
// In src/services/strategy/graph.ts
export interface SwapEdge {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  protocol: string;
  feeBps: bigint;
  // New pre-calculated fields
  zeroForOne: boolean;
  tokenInIdx: number;
  tokenOutIdx: number;
}
```

- [ ] **Step 2: Populate fields in `buildGraph`**

```typescript
// In src/services/strategy/graph.ts
// Update buildGraph to populate the new fields using inferZeroForOne/inferTokenIdx logic 
// moved from simulator.ts
```

- [ ] **Step 3: Update `simulateRoute` to use pre-calculated fields**

```typescript
// In src/services/strategy/simulator.ts
// Remove inferZeroForOne and inferTokenIdx calls from the loop.
// Use edge.zeroForOne, etc. directly.
```

- [ ] **Step 4: Commit**

```bash
git add src/services/strategy/graph.ts src/services/strategy/simulator.ts src/services/strategy/finder.ts
git commit -m "perf: pre-calculate swap parameters for faster simulation"
```

---

### Task 5: Priority for HyperIndex State

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Ensure HyperIndex reader is the primary source**

```typescript
// In runPassLoop, ensure we are not unnecessarily calling hydration service 
// if HyperIndex is healthy.
```

- [ ] **Step 2: Final Verification**

Run: `bun test`

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/pass_loop.ts
git commit -m "perf: prioritize hyperindex for state management"
```
