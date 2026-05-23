# Predictive Market Impact Modeling Design

## Overview
Replace the static `slippageBps` pruning logic with a dynamic market impact model that estimates execution slippage based on current pool reserves and liquidity depth.

## Proposed Architecture
1. **Impact Estimator**: A new module that calculates the price impact of a given trade amount on a pool, using the current `stateRef`.
2. **Simulation Pipeline Integration**: Before the final `simulateRoute`, we run a quick `estimateImpact` calculation. If the estimated price impact for the desired trade size exceeds a dynamically calculated threshold, the route is pruned early.
3. **Liquidity Curve Aware**: Utilize the existing `core/math/` modules (V2, V3, Balancer) to compute `getAmountOut` for the specific input size and compare it to the spot price, identifying paths that offer insufficient liquidity for the target trade size.

## Implementation Details
- Add `getEffectivePriceImpact(edge: SwapEdge, amountIn: bigint): number` to `simulator.ts`.
- In `pipeline.ts`, integrate this check before `simulateRoute`.

**Does this design approach (dynamic impact estimation vs. static slippage pruning) sound optimal, or should we refine how the threshold is calculated?**
