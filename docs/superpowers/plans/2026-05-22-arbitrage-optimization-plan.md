# Arbitrage Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize arbitrage discovery by implementing liquidity-based pruning and pipeline early exits to reduce latency and improve profitability filtering.

**Architecture:** 
1. Introduce a helper for USD liquidity calculation (using oracle rate).
2. Filter pools at `runPassLoop` entry to remove low-liquidity pools from the routing graph.
3. Update `PipelineOptions` to include `minLiquidityUsd` for potential further runtime pruning.

**Tech Stack:** Bun/TypeScript.

---

### Task 1: Create USD Liquidity Helper

**Files:**
- Create: `src/core/assessment/liquidity.ts`
- Test: `src/core/assessment/liquidity.test.ts`

- [ ] **Step 1: Write helper function**
Implement `calculateLiquidityUsd(pool: PoolMeta, state: PoolState, tokenToMaticRate: bigint): bigint` in `src/core/assessment/liquidity.ts`. This will use `pool.tokens` and `state` to estimate total value.

- [ ] **Step 2: Write tests for helper**
Create test cases for Uniswap V2 (reserves) and V3 (liquidity/price) scenarios.

- [ ] **Step 3: Run tests**
Run `bun test src/core/assessment/liquidity.test.ts`

---

### Task 2: Implement Pool Filtering in runPassLoop

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Add pool filtering**
Modify `runPassLoop` to call `calculateLiquidityUsd` on discovered pools before rebuilding the routing graph.

- [ ] **Step 2: Add test check**
Ensure that pools with liquidity below the configured floor are excluded from the `pools` array used for graph building.

- [ ] **Step 3: Run pass_loop tests**
Run `bun test src/orchestrator/pass_loop.test.ts`

