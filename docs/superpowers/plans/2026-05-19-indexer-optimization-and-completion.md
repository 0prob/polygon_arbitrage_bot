# Indexer Optimization and Protocol Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate hot-path RPC calls in the Balancer indexer, complete Curve and Dodo protocol indexing, and optimize initial sync performance.

**Architecture:** 
- Envio indexer with handlers for Uniswap V2/V3/V4, Balancer, Curve, and Dodo.
- Use `context.PoolMeta.get` and `context.BalancerPoolState.get` for efficient local DB lookups instead of RPC effects.
- Dynamic contract registration for pools.

**Tech Stack:** TypeScript, Envio, Viem, GraphQL.

---

### Task 1: Balancer Incremental Update Optimization

**Files:**
- Modify: `hyperindex/src/handlers/balancer.ts`

- [ ] **Step 1: Refactor Swap handler to use local state**

```typescript
// Replace the Swap event handler with:
indexer.onEvent(
  { contract: "BalancerVault", event: "Swap" },
  async ({ event, context }: any) => {
    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    const poolAddr = mapping.address;
    const [state, meta] = await Promise.all([
      context.BalancerPoolState.get(poolAddr),
      context.PoolMeta.get(poolAddr)
    ]);

    if (!state || !meta) {
      // Fallback to effect if state missing (initialization)
      const metaEffect = await context.effect(fetchBalancerMetadata, { pool: poolAddr });
      context.BalancerPoolState.set({
        id: poolAddr,
        address: poolAddr,
        lastUpdatedBlock: Number(event.block.number),
        poolId: poolId,
        balances: metaEffect.balances,
        swapFee: 0n,
      });
      return;
    }

    const tIn = event.params.tokenIn.toLowerCase();
    const tOut = event.params.tokenOut.toLowerCase();
    const aIn = event.params.amountIn;
    const aOut = event.params.amountOut;

    const tokens = meta.tokens as string[];
    const balances = [...state.balances];

    const idxIn = tokens.indexOf(tIn);
    const idxOut = tokens.indexOf(tOut);

    if (idxIn >= 0) balances[idxIn] += aIn;
    if (idxOut >= 0) balances[idxOut] -= aOut;

    context.BalancerPoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);
```

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/balancer.ts
git commit -m "perf(indexer): incremental updates for Balancer swaps"
```

---

### Task 2: Balancer Liquidity Tracking

**Files:**
- Modify: `hyperindex/config.yaml`
- Modify: `hyperindex/src/handlers/balancer.ts`

- [ ] **Step 1: Add PoolBalanceChanged event to config.yaml**

```yaml
      - name: BalancerVault
        # ...
        events:
          - event: PoolRegistered
          - event: TokensRegistered
          - event: Swap
          - event: PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] amounts, uint256[] paidProtocolSwapFeeAmounts)
```

- [ ] **Step 2: Implement PoolBalanceChanged handler**

```typescript
// Add to balancer.ts:
indexer.onEvent(
  { contract: "BalancerVault", event: "PoolBalanceChanged" },
  async ({ event, context }: any) => {
    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    const state = await context.BalancerPoolState.get(mapping.address);
    if (!state) return;

    const amounts = event.params.amounts; // int256[]
    const balances = [...state.balances];

    for (let i = 0; i < balances.length; i++) {
      balances[i] += BigInt(amounts[i] || 0);
    }

    context.BalancerPoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);
```

- [ ] **Step 3: Commit**

```bash
git add hyperindex/config.yaml hyperindex/src/handlers/balancer.ts
git commit -m "feat(indexer): track Balancer liquidity changes"
```

---

### Task 3: Curve Protocol Completion

**Files:**
- Create: `hyperindex/src/handlers/curve_pool.ts`
- Modify: `hyperindex/config.yaml`
- Modify: `hyperindex/abis/curve_pool.json`

- [ ] **Step 1: Update curve_pool.json ABI**

```json
[
  {
    "name": "TokenExchange",
    "type": "event",
    "inputs": [
      { "indexed": true, "name": "buyer", "type": "address" },
      { "indexed": false, "name": "sold_id", "type": "int128" },
      { "indexed": false, "name": "tokens_sold", "type": "uint256" },
      { "indexed": false, "name": "bought_id", "type": "int128" },
      { "indexed": false, "name": "tokens_bought", "type": "uint256" }
    ]
  },
  {
    "name": "AddLiquidity",
    "type": "event",
    "inputs": [
      { "indexed": true, "name": "provider", "type": "address" },
      { "indexed": false, "name": "token_amounts", "type": "uint256[]" },
      { "indexed": false, "name": "fees", "type": "uint256[]" },
      { "indexed": false, "name": "invariant", "type": "uint256" },
      { "indexed": false, "name": "token_supply", "type": "uint256" }
    ]
  },
  {
    "name": "RemoveLiquidity",
    "type": "event",
    "inputs": [
      { "indexed": true, "name": "provider", "type": "address" },
      { "indexed": false, "name": "token_amounts", "type": "uint256[]" },
      { "indexed": false, "name": "fees", "type": "uint256[]" },
      { "indexed": false, "name": "token_supply", "type": "uint256" }
    ]
  }
]
```

- [ ] **Step 2: Add CurvePool contract to config.yaml**

```yaml
      - name: CurvePool
        abi_file_path: abis/curve_pool.json
        handler: src/handlers/curve_pool.ts
        events:
          - event: TokenExchange
          - event: AddLiquidity
          - event: RemoveLiquidity
```

- [ ] **Step 3: Implement curve_pool.ts handlers**

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "CurvePool", event: "TokenExchange" },
  async ({ event, context }: any) => {
    const pool = event.srcAddress.toLowerCase();
    const state = await context.CurvePoolState.get(pool);
    if (!state) return;

    const balances = [...state.balances];
    const soldId = Number(event.params.sold_id);
    const boughtId = Number(event.params.bought_id);

    balances[soldId] += event.params.tokens_sold;
    balances[boughtId] -= event.params.tokens_bought;

    context.CurvePoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);
// ... implement AddLiquidity and RemoveLiquidity similarly ...
```

- [ ] **Step 4: Commit**

```bash
git add hyperindex/src/handlers/curve_pool.ts hyperindex/config.yaml hyperindex/abis/curve_pool.json
git commit -m "feat(indexer): complete Curve protocol tracking"
```

---

### Task 4: Dodo Protocol Completion

**Files:**
- Create: `hyperindex/src/handlers/dodo_pool.ts`
- Modify: `hyperindex/config.yaml`
- Modify: `hyperindex/src/handlers/dodo_factory.ts`

- [ ] **Step 1: Enable Dodo pool registration in factory**

```typescript
// In dodo_factory.ts, uncomment:
context.chain.DodoPool.add(pool);
```

- [ ] **Step 2: Add DodoPool contract to config.yaml**

```yaml
      - name: DodoPool
        abi_file_path: abis/uniswap_v2_pool.json # Using V2 for Sync event
        handler: src/handlers/dodo_pool.ts
        events:
          - event: Sync(uint256 reserve0, uint256 reserve1)
```

- [ ] **Step 3: Implement dodo_pool.ts handler**

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "DodoPool", event: "Sync" },
  async ({ event, context }: any) => {
    context.DodoPoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: Number(event.block.number),
      baseReserve: event.params.reserve0,
      quoteReserve: event.params.reserve1,
      // Target reserves might need separate tracking or initialization
      targetBase: event.params.reserve0,
      targetQuote: event.params.reserve1,
      rStatus: 0,
      k: 0n,
      fee: 0n,
    });
  },
);
```

- [ ] **Step 4: Commit**

```bash
git add hyperindex/src/handlers/dodo_pool.ts hyperindex/config.yaml hyperindex/src/handlers/dodo_factory.ts
git commit -m "feat(indexer): complete Dodo protocol tracking"
```

---

### Task 5: Sync Optimization & Cleanup

**Files:**
- Modify: `hyperindex/config.yaml`
- Delete: `hyperindex/src/effects/token_decimals.ts`

- [ ] **Step 1: Update start blocks to ~58M (Polygon recent block)**

```yaml
chains:
  - id: 137
    start_block: ${POLYGON_START_BLOCK:-58000000}
```

- [ ] **Step 2: Remove unused effect**

```bash
rm hyperindex/src/effects/token_decimals.ts
```

- [ ] **Step 3: Commit**

```bash
git add hyperindex/config.yaml
git commit -m "perf(indexer): optimize sync start block and clean up"
```
