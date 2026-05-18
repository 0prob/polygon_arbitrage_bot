# Design: Gas and Math Optimization

## 1. Problem Statement
The current gas and profit calculation logic has several issues:
1.  **Bug in Gas Sanity Check**: In `src/arb/profit_compute.ts`, `gasCost` (in MATIC wei) is compared directly to `minNetProfit` (in start token units), leading to incorrect rejections of profitable arbs when the start token has different decimals or value compared to MATIC.
2.  **Conservative Gas Bidding**: The current priority fee floor is 25 gwei, while Polygon's effective floor is often 30 gwei. Bidding is capped at 3x, which may not be competitive enough for high-value arbs.
3.  **Stale Prices**: The MATIC/USD price oracle has a 1-hour staleness threshold, which is too long for volatile markets.
4.  **Simulation Overhead**: The Uniswap V3 simulation loop performs repeated type conversions (`toBigIntOrNull`) on hot paths.
5.  **Rounding Inconsistency**: Gas-to-token conversions should consistently round UP to be conservative.

## 2. Proposed Changes

### 2.1 fix(arb): Correct Gas Sanity Check in `profit_compute.ts`
Instead of comparing `gasCost` to `minNetProfit`, we should either:
-   Compare `gasCost` (wei) to `minProfitWei` (wei).
-   Compare `gasCostInTokens` (raw units) to `minNetProfit` (raw units).
We will choose the latter for consistency within `computeProfit`.

### 2.2 perf(gas): Update Polygon Gas Floor and Bidding
-   Increase `GasOracle` floor to 30 gwei.
-   Increase default `maxMultiplierBps` to 50,000 (5x) in `scalePriorityFeeByProfitMargin`.

### 2.3 fix(oracle): Tighten MATIC/USD Staleness
-   Reduce `MATIC_USD_STALE_AFTER_MS` to 5 minutes (300,000 ms).

### 2.4 perf(math): Optimize V3 Simulation Loop
-   Pre-cast state variables (`sqrtPriceX96`, `liquidity`) to BigInt before the loop.
-   Ensure `tickData.liquidityNet` is accessed directly as BigInt (assuming the hydrator ensures this).

### 2.5 chore(math): Standardize Rounding
-   Ensure `gasCostInTokenUnits` consistently uses `divRoundingUp`.
-   Verify all gas-related math in `profit_compute.ts` is conservative.

## 3. Implementation Plan
See `docs/superpowers/plans/2026-05-18-gas-and-math-optimization.md` (to be updated).

## 4. Verification Plan
-   Unit tests for `computeProfit` with various token decimals (USDC 6, WBTC 8, WETH 18).
-   Benchmark Uniswap V3 simulation before/after optimization.
-   Verify gas bidding logic with mock oracle data.
