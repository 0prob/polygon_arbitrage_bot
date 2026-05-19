# Uniswap V4 Arbitrage Integration

**Date:** 2026-05-19
**Status:** Draft

## Overview

Integrate Uniswap V4 into the Polygon arbitrage bot — indexing, simulation, and on-chain execution. V4 uses a single `PoolManager` contract with `bytes32` pool IDs, `Initialize` events for pool creation, and a `lock()` / `lockAcquired()` callback pattern for swaps that is architecturally different from V3's per-pool callbacks.

## 1. HyperIndex Schema

Add `V4PoolState` entity to `hyperindex/schema.graphql`:

```graphql
type V4PoolState {
  id: ID!
  address: String!
  lastUpdatedBlock: Int!
  sqrtPriceX96: BigInt!
  liquidity: BigInt!
  tick: Int!
  fee: BigInt!
  tickSpacing: Int!
  hooks: String!
}
```

Pool metadata (`PoolMeta`) already handles protocol-agnostic pool discovery — V4 pools are keyed by their `bytes32` pool ID (lowercased) as the `address` field.

## 2. HyperIndex Config

Add two contracts to `hyperindex/config.yaml` under chain 137:

- **`PoolManager`** (static address `0x67366782805870060151383f4bbff9dab53e5cd6`):
  - `Initialize` event → handler `v4_factory.js`
  - `Swap` event → handler `v4_pool.js`

No wildcard contracts needed — all V4 events come from the single PoolManager address, with the pool ID as an indexed event parameter.

ABI file: `abis/uniswap_v4_pool_manager.json` (fetched from Polygonscan or the V4 repo).

## 3. HyperIndex Handlers

### `src/handlers_ts/v4_factory.ts` (Initialize handler)

- Listens for `Initialize` events on `PoolManager`
- Event params: `id` (bytes32 pool ID), `currency0`, `currency1`, `fee`, `tickSpacing`, `hooks`, `sqrtPriceX96`, `tick`
- Creates `PoolMeta` with `id = poolId.toLowerCase()`, `protocol = "uniswap_v4"`
- Creates `V4PoolState` with initial `sqrtPriceX96`, `tick`, `liquidity`, `fee`, `tickSpacing`, `hooks`
- Note: `currency0` and `currency1` must be normalized (lowercased) for token address consistency

### `src/handlers_ts/v4_pool.ts` (Swap handler)

- Listens for `Swap` events on `PoolManager`
- Event params: `id`, `sender`, `amount0`, `amount1`, `sqrtPriceX96`, `liquidity`, `tick`, `fee`
- Updates `V4PoolState` with post-swap state
- Pool lookup via `event.params.id` (bytes32 pool ID, lowercased)

## 4. Bot-side Simulation

V4 uses the same concentrated liquidity formula as V3 (`x * y = k` within tick ranges). Reuse `src/core/math/uniswap_v3.ts` for swap simulation — the math for `simulateV3Swap()` works for V4 without modification.

### Changes:

- **`src/core/types/protocol.ts`**: Add `UNISWAP_V4 = "uniswap_v4"` to protocol enum
- **`src/infra/db/hyperindex_reader.ts`**: Add `readV4PoolState()` — reads `v4_pool_state` table, returns `{ sqrtPriceX96, liquidity, tick, fee, tickSpacing, hooks }`
- **`src/services/strategy/graph.ts`**: Recognize `"uniswap_v4"` protocol when building edges
- **`src/services/strategy/simulator.ts`**: Route `"uniswap_v4"` protocol to V3 swap math

## 5. Calldata Encoding

### `src/services/execution/calldata.ts` — new `encodeV4Hop()`

Each V4 hop is wrapped in a `PoolManager.lock()` call:

```
Call 0: ArbExecutor.approveIfNeeded(tokenIn, PoolManager, amountIn)
Call 1: PoolManager.lock(abi.encode(PoolKey, zeroForOne, amountSpecified, sqrtPriceLimitX96))
  → PoolManager calls ArbExecutor.lockAcquired(data)
  → ArbExecutor decodes PoolKey + swap params
  → ArbExecutor calls PoolManager.swap(key, zeroForOne, amountSpecified, sqrtPriceLimitX96, "")
  → PoolManager settles: takes tokenIn, sends tokenOut
  → lockAcquired returns → lock released
```

`PoolKey` structure: `(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)`

The `tickSpacing` and `hooks` fields come from `V4PoolState` stored at indexing time.

### `encodeRoute()` update

Add routing for `"UNISWAP_V4"` protocol:
```typescript
} else if (proto === "UNISWAP_V4") {
  calls.push(...encodeV4Hop(hop, executor));
}
```

## 6. ArbExecutor Contract

### New state

```solidity
address public immutable poolManager;
```

Added to constructor parameters (validated for non-zero).

### New callback

```solidity
function lockAcquired(bytes calldata data) external returns (bytes memory) {
    if (msg.sender != poolManager) revert CallbackOnly();
    if (_phase != PHASE_CALLBACK) revert CallbackOnly();
    // Decode PoolKey + swap params from data
    // Call PoolManager.swap(key, zeroForOne, amountSpecified, sqrtPriceLimitX96, "")
    // Return result
}
```

The callback validates:
- Only callable by PoolManager
- Only during PHASE_CALLBACK (within a flash loan execution)

### New protocol constant

```solidity
uint8 private constant PROTOCOL_UNISWAP_V4 = 5;
```

The V4 swap callback validation is simpler than V3 since there's only one PoolManager — no factory lookup needed.

### Deployment note

The updated ArbExecutor must be deployed with the V4 PoolManager address on Polygon (`0x67366782805870060151383f4bbff9dab53e5cd6`). The `executorAddress` in the bot config must point to the new deployment.

## 7. Execution Integration

The existing execution pipeline handles V4 transparently:
1. Cycle enumeration finds V4-inclusive routes
2. Simulation runs V3 math against V4 pool states
3. Route encoding uses `encodeV4Hop()` for V4 edges
4. ArbExecutor processes `PoolManager.lock()` calls via `lockAcquired()` callback
5. Flash loan repayment and profit assertion work the same as today

## 8. ABI File

The V4 PoolManager ABI (`abis/uniswap_v4_pool_manager.json`) includes at minimum these events and functions:

- `event Initialize(...)` — all PoolKey fields + sqrtPriceX96 + tick
- `event Swap(...)` — id, sender, amounts, sqrtPriceX96, liquidity, tick, fee
- `function lock(bytes calldata) external returns (bytes memory)`
- `function swap(PoolKey calldata, bool, int128, uint160, bytes calldata) external returns (int256, int256)`
- `function settle(address) external payable`
- `function take(address, address, uint256) external`

## 9. Implementation Order

1. Fetch V4 PoolManager ABI from Polygon
2. Add `V4PoolState` to schema.graphql, re-run codegen
3. Add PoolManager contract to config.yaml, update handler imports
4. Write `v4_factory.ts` and `v4_pool.ts` handlers
5. Verify compile passes with `hi:compile`
6. Re-index: `hi:start -- -r`
7. Add V4 protocol support to bot types, state reader, graph, simulator
8. Add `encodeV4Hop()` calldata encoder
9. Update ArbExecutor contract with `poolManager` address and `lockAcquired()` callback
10. Deploy updated ArbExecutor, update config
11. Test end-to-end with a known V4 pool
