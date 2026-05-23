# Arbitrage Discovery Pipeline Optimizations

## Overview
Implement liquidity-based pruning and pipeline early exits to reduce discovery latency and improve profitability filtering.

## Liquidity Filtering (Spatial Pruning)
Currently, `liquidityFloorUsd` exists in config but is unused. 
1. Implement a `getPoolLiquidityUsd(state: PoolState, protocol: string): bigint` helper.
2. In `runPassLoop`, filter pools by this threshold before passing to `buildGraph`.

## Pipeline Early Exit
In `evaluatePipeline`, add heuristic pruning based on cumulative path fees or potential gross profit before calling the simulation function, if possible. (e.g., if gross fee > max profit from oracle price, skip).

## Strategy Optimization
Implement `enumerateCycles` filtering to prune high-hop routes that have historically poor performance, based on `revertRiskBps`.

## Implementation Plan
1. Helper for USD liquidity calculation (using oracle rate).
2. Filter pools at `runPassLoop` entry.
3. Update `PipelineOptions` to include `minLiquidityUsd`.
