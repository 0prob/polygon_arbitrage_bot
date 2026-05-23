# Incremental Graph Updates Design

## Overview
Replace the full-graph rebuild logic with an incremental update mechanism to significantly improve performance during real-time state changes.

## Current Architecture
- `runPassLoop` checks `pools.length !== lastPoolCount || !cachedGraph`.
- `buildGraph` is a complete rebuild of the `RoutingGraph` adjacency map.

## Proposed Architecture
1. **GraphManager**: A new service wrapping the `RoutingGraph` with `updatePool(address: Address, state: PoolState)` capabilities.
2. **Adjacency Mapping**: Maintain the existing `RoutingGraph` in memory and update only the specific `SwapEdge` entries associated with the updated `poolAddress`.
3. **Graph Invalidation**: If the number of pools changes (new/removed), trigger a full rebuild. For state-only changes, trigger an incremental update.

## Implementation Details
- `GraphManager.updatePool(addr, state)`: 
  1. Look up pool meta.
  2. Map state updates to existing edges in the adjacency list for that pool.
  3. Ensure state refs remain consistent.

**Does this design approach (separating full-rebuild vs. incremental state update) sound optimal, or should we consider a different way to manage the graph state?**
