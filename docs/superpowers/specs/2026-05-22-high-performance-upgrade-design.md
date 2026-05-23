# High-Performance Arbitrage Upgrade

## Overview
Transform the bot's core loop from a static interval to a multi-tiered, high-performance architecture.

## Architecture
1. **PassRunner**: Split evaluation frequencies (200ms for 2-hop, 1s for 4-hop).
2. **Instrumentation**: Add Profit/s metric to TUI dashboard.
3. **Real-time Ingestion**: Add WebSocket support for real-time pool updates (Direct mempool/stream).
4. **Optimized Topology**: Implement incremental graph updates for localized pool state changes.
5. **Execution**: Implement raw viem broadcast for parallelized relay submission.

## Proposed Design Sections

### 1. PassRunner Differential Frequency
Refactor the loop to have two queues or triggers. The 2-hop finder runs on a high-frequency trigger, while 4-hop and full graph rebuilds run on a lower-frequency background task.

### 2. Profit/s Metric
Track `totalProfit` and `uptime` in `TuiState`, exposing `profitPerSecond` in the metrics pane.

### 3. Real-time Ingestion (WebSocket)
Add an `EventEmitter` to the HyperSync client or a dedicated WebSocket reader that pushes state updates directly into the `stateCache` rather than waiting for GraphQL polls.

### 4. Incremental Graph Updates
Modify `buildGraph` or introduce a `GraphManager` that accepts a `poolAddress` and `newState` to update only the edges associated with that pool in the adjacency map.

---

**Does this design approach address your performance requirements, or should we prioritize one of these over the others?**
