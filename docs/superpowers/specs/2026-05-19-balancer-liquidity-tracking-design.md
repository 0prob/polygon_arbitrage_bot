# Design Spec: Balancer Liquidity Tracking

Implement tracking of Balancer `PoolBalanceChanged` events to maintain accurate pool balances in the indexer.

## 1. Explore Project Context
- `hyperindex/config.yaml` defines the events being indexed.
- `hyperindex/src/handlers/balancer.ts` contains the logic for handling Balancer-specific events.
- `hyperindex/schema.graphql` defines the `BalancerPoolState` entity.

## 2. Approach
We will add the `PoolBalanceChanged` event to the `BalancerVault` contract in `config.yaml`. Then, we will implement a handler in `balancer.ts` that adjusts the `balances` array in `BalancerPoolState` based on the `amounts` reported in the event.

## 3. Design Sections

### 3.1 configuration Change
Add the following event to `BalancerVault` in `hyperindex/config.yaml`:
```yaml
          - event: PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] amounts, uint256[] paidProtocolSwapFeeAmounts)
```

### 3.2 Handler Implementation
Implement the `PoolBalanceChanged` handler in `hyperindex/src/handlers/balancer.ts`:
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

## 4. Testing & Verification
- Verify that `hyperindex/config.yaml` is syntactically correct.
- Verify that `hyperindex/src/handlers/balancer.ts` compiles (type checking).
- Ensure the logic correctly handles `int256` amounts by converting to `BigInt`.
