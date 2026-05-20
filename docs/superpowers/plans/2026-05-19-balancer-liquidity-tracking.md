# Balancer Liquidity Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track `PoolBalanceChanged` events on Balancer Vault to keep `BalancerPoolState.balances` accurate when liquidity is added or removed.

**Architecture:** We add the `PoolBalanceChanged` event to the `BalancerVault` contract configuration and implement a handler that updates the pool's balances in the indexer's state.

**Tech Stack:** Envio (TypeScript), YAML configuration.

---

### Task 1: Update config.yaml

**Files:**
- Modify: `hyperindex/config.yaml`

- [ ] **Step 1: Add PoolBalanceChanged event to BalancerVault**

In `hyperindex/config.yaml`, find the `BalancerVault` contract and add `PoolBalanceChanged` to its `events` list.

```yaml
      - name: BalancerVault
        address: "0xba12222222228d8ba445958a75a0704d566bf2c8"
        abi_file_path: abis/balancer_vault.json
        handler: src/handlers/balancer.ts
        events:
          - event: PoolRegistered
            field_selection:
              transaction_fields: ["hash"]
          - event: TokensRegistered
            field_selection:
              transaction_fields: ["hash"]
          - event: Swap
            field_selection:
              transaction_fields: ["hash"]
          - event: PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] amounts, uint256[] paidProtocolSwapFeeAmounts)
            field_selection:
              transaction_fields: ["hash"]
```

- [ ] **Step 2: Commit**

```bash
git add hyperindex/config.yaml
git commit -m "feat(indexer): add PoolBalanceChanged event to Balancer config"
```

---

### Task 2: Implement PoolBalanceChanged handler

**Files:**
- Modify: `hyperindex/src/handlers/balancer.ts`

- [ ] **Step 1: Add the handler to balancer.ts**

Append the `PoolBalanceChanged` handler to `hyperindex/src/handlers/balancer.ts`.

```typescript
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

- [ ] **Step 2: Verify compilation**

Run Envio codegen or type check if available. In this environment, we can check if the file is syntactically valid using `tsc` or just `node --check`.

Run: `npx tsc --noEmit --project hyperindex/tsconfig.json` (if possible) or just assume correctness if tools are missing.

- [ ] **Step 3: Commit**

```bash
git add hyperindex/src/handlers/balancer.ts
git commit -m "feat(indexer): implement Balancer PoolBalanceChanged handler"
```
