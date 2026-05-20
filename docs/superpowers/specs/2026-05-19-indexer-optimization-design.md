# Design: Indexer Optimization and Protocol Completion

## Overview
This design aims to improve the efficiency and coverage of the Envio indexer used by the arbitrage bot. Key focus areas are reducing RPC calls, fixing misconfigured ABIs, and completing event tracking for Curve and Dodo protocols.

## 1. Balancer Vault Optimization
### Current Issues
- `BalancerVault.Swap` handler calls `fetchBalancerMetadata` effect on every swap, resulting in high latency and RPC load.
- `PoolBalanceChanged` (liquidity additions/removals) is not tracked.
- `swapFee` is hardcoded to `0n`.

### Changes
- **Incremental Updates:** Refactor `src/handlers/balancer.ts` to use `context.BalancerPoolState.get(poolAddress)` and `PoolMeta` info to update balances incrementally without RPC.
- **Liquidity Tracking:** Add `PoolBalanceChanged` event to `config.yaml` and implement handler.
- **RPC Removal:** Use `context.effect` only during initial `PoolRegistered` or if state is missing.

## 2. Curve Protocol Completion
### Current Issues
- `config.yaml` registers `CurvePool` via `contractRegister` but doesn't define the `CurvePool` contract or handler.
- `curve_pool.json` ABI is a placeholder/duplicate of Uniswap V2.
- No swap or liquidity events are indexed.

### Changes
- **ABI Fix:** Replace `abis/curve_pool.json` with correct events: `TokenExchange`, `AddLiquidity`, `RemoveLiquidity`.
- **Contract Registration:** Add `CurvePool` contract to `chains` in `config.yaml`.
- **Handlers:** Create `src/handlers/curve_pool.ts` to process swaps and liquidity updates.

## 3. Dodo Protocol Completion
### Current Issues
- Dodo pools are registered in `PoolMeta` but contract registration for event indexing is commented out.
- No swap handlers exist for Dodo pools.

### Changes
- **Uncomment Registration:** Enable `context.chain.DodoPool.add(pool)` in `dodo_factory.ts`.
- **Contract Definition:** Add `DodoPool` to `config.yaml`.
- **Handlers:** Create `src/handlers/dodo_pool.ts` with handlers for `Sync`, `Buy`, `Sell`, and liquidity events.

## 4. General Optimizations
- **Start Blocks:** Update `config.yaml` with more recent `start_block` values for Polygon and Katana to avoid scanning ancient history.
- **Cleanup:** Remove unused `TokenMeta` and `token_decimals.ts` if confirmed redundant.
- **Type Safety:** Ensure all handlers use proper types and handle `null`/`undefined` states.

## Success Criteria
- Zero RPC calls during steady-state swap indexing.
- Accurate balances for Balancer, Curve, and Dodo pools.
- Reduced initial sync time.
