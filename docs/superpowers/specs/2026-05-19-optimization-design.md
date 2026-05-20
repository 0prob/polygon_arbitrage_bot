# Optimization Design: Arbitrage Bot Efficiency

## Overview
This document outlines the optimizations to be implemented to reduce lag, sync times, and unnecessary resource usage in the arbitrage bot.

## 1. Database Connection Persistence
### Current State
`buildStateCacheFromHyperIndex` in `src/infra/db/hyperindex_reader.ts` creates and closes a `CompatDatabase` on every call.
### Change
Introduce a module-level variable to hold a single `CompatDatabase` instance. This preserves the statement cache and avoids the overhead of repeated connections.
### Implementation Detail
```typescript
let _hiDb: CompatDatabase | null = null;
export function buildStateCacheFromHyperIndex(hiDbPath: string, _addresses: string[]): StateCache {
  if (!_hiDb) _hiDb = createDatabase(hiDbPath);
  // ... reuse _hiDb ...
}
```

## 2. Loop & RPC Caching
### Current State
`runPassLoop` in `src/orchestrator/pass_loop.ts` re-calculates cycles and fetches gas prices from RPC every iteration.
### Change
1.  **Cycle Caching:** Store the last set of pools and the resulting cycles. Only re-run `enumerateCycles` if the pool list has changed.
2.  **Gas Price Caching:** Store the last gas price and its timestamp. Only fetch from RPC if more than 1 second has passed.
### Implementation Detail
Add local state variables in `runPassLoop` (or a helper class).

## 3. Simulation Hot-path Optimization
### Current State
`simulateRoute` calls `inferZeroForOne` and `inferTokenIdx` (using `findIndex`) for every hop in every cycle.
### Change
1.  Extend `SwapEdge` to include `zeroForOne: boolean`, `tokenInIdx: number`, and `tokenOutIdx: number`.
2.  Populate these fields when building the `RoutingGraph`.
3.  Update `simulateHop` to use these pre-calculated values.
### Implementation Detail
Modify `src/services/strategy/graph.ts` and `src/services/strategy/simulator.ts`.

## 4. Uniswap V4 Indexer Fix
### Current State
The `Swap` event handler in `hyperindex/src/handlers/v4.ts` resets `tickSpacing` to `0` and `hooks` to `""`.
### Change
Ensure the `Swap` event update only modifies price, liquidity, and tick.
### Implementation Detail
In Envio, if we want to update only specific fields, we might need to use a partial update or a different pattern. However, for `Swap`, we can just omit the constant fields if the schema allows, or ensure they are passed correctly.

## 5. Unified State Management
### Change
Modify `runPassLoop` and `HydrationService` to ensure `hyperindex` is the primary source of truth, reducing redundant RPC polling for pool states.

## Success Criteria
- Reduced CPU usage in the main loop.
- Reduced RPC call volume for `eth_getBlockByNumber`.
- Correct Uniswap V4 state updates in the indexer.
- Faster cycle through-put.
