# Envio Indexer Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Envio indexer performance by parallelizing async operations and reducing redundant RPC calls.

**Architecture:** 
1. Modify `fetchBalancerMetadata` effect to accept an optional `poolId` to skip an RPC call.
2. Parallelize multiple `context.get()` and `context.effect()` calls using `Promise.all` in handlers.
3. Add existence checks before calling expensive effects in `CurveRegistry` handlers.

**Tech Stack:** TypeScript, Envio (Indexer SDK), Viem.

---

### Task 1: Optimize `fetchBalancerMetadata` Effect

**Files:**
- Modify: `hyperindex/src/effects/balancer_metadata.ts`

- [ ] **Step 1: Update input schema and implementation**
  - Update `input` to include optional `poolId: S.string`.
  - In the effect implementation, use the provided `poolId` if it exists.

```typescript
export const fetchBalancerMetadata = createEffect(
  {
    name: "fetchBalancerMetadata",
    input: { pool: S.string, poolId: S.optional(S.string) },
    output: { poolId: S.string, balances: S.array(S.bigint), tokens: S.array(S.string), lastChangeBlock: S.bigint },
    rateLimit: { calls: 20, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const poolId = (input.poolId as `0x${string}`) || 
        await client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getPoolId" });
      
      const vault = "0xba12222222228d8ba445958a75a0704d566bf2c8" as const;
      const [tokens, balances, lastChangeBlock] = await client.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "getPoolTokens",
        args: [poolId],
      });
      return {
        poolId: poolId as string,
        tokens: (tokens as string[]).map(t => t.toLowerCase()),
        balances: (balances as bigint[]).map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock as bigint),
      };
    } catch {
      return { poolId: "", tokens: [], balances: [], lastChangeBlock: 0n };
    }
  },
);
```

### Task 2: Optimize Balancer Handlers

**Files:**
- Modify: `hyperindex/src/handlers/balancer.ts`

- [ ] **Step 1: Pass `poolId` to effect in `PoolRegistered`**
- [ ] **Step 2: Pass `poolId` to effect in `Swap` fallback**
- [ ] **Step 3: Review and parallelize other handlers if possible**

```typescript
// Example for PoolRegistered
const meta = await context.effect(fetchBalancerMetadata, { pool, poolId });

// Example for Swap fallback
const metaEffect = await context.effect(fetchBalancerMetadata, { pool: poolAddr, poolId });
```

### Task 3: Optimize Curve Registry Handlers

**Files:**
- Modify: `hyperindex/src/handlers/curve_factory.ts`

- [ ] **Step 1: Add existence checks before `fetchCurveMetadata`**
  - In `contractRegister`, check if pool already added (though `contractRegister` is usually first).
  - In `onEvent("PoolAdded")`, check if `PoolMeta` already exists.

```typescript
indexer.onEvent(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }: any) => {
    const pool = event.params.pool.toLowerCase();
    
    // Check if already exists to avoid redundant effect call
    const existing = await context.PoolMeta.get(pool);
    if (existing) return;

    const meta = await context.effect(fetchCurveMetadata, { pool, nCoins: 8 });
    // ... rest of logic
  },
);
```

### Task 4: Verification

- [ ] **Step 1: Run Envio codegen**
  - Run `npx envio codegen` in the `hyperindex` directory to ensure all changes are valid and types are correct.

---
