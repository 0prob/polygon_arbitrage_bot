# TUI Dashboard Design

## Overview
Transform the existing linear TUI into a robust, modular grid-based dashboard for real-time monitoring of all bot components.

## Dashboard Layout
The dashboard will use a 4-pane grid system, plus a persistent status bar and keymap.

| Panel | Responsibility |
|-------|----------------|
| **Status/System** | Runtime, Uptime, Memory, Hyperindex Sync Block/Remote, Gas Oracle |
| **Component Health**| Execution service state, Mempool status, Cross-chain arb status |
| **Arbitrage Stats** | Real-time performance (Total Profit, Executed Cycles, Success Rate, Avg Profit) |
| **Activity Log** | Scrollable log + "Current Action" (e.g., "Simulating Cycle 42...") |

## Architecture
- **Event System:** Extend `ArbEvent` to emit new metrics for each component (e.g., `HyperindexStatus`, `ExecutionStatus`, `GasUpdate`).
- **State Model:** `TuiState` will be structured into sub-objects for `System`, `Health`, `Stats`, and `Activity`.
- **Renderer:** Update `Renderer` to define grid rectangles. Use a flexible zone calculation (rows/cols) rather than fixed heights.

## Implementation Details
- **Sync Status:** Track `syncedBlock` and `remoteBlock` and display progress percentage/lag.
- **Current Action:** Bot will emit a new event type `current_action` (e.g., "Graph Rebuild", "Simulation") to keep the log/activity pane updated with what the worker is doing.
- **Component Health:** Add a "heartbeat" mechanism to the Gas Oracle and Execution service to track staleness.

## Success Criteria
- [ ] User can see sync progress.
- [ ] User can see bot profitability at a glance.
- [ ] User can see what action the bot is currently taking.
- [ ] Bot health is visualized (e.g., service uptime/status).
