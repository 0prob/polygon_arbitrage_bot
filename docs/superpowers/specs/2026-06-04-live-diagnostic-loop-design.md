# Design Spec: Live Diagnostic Loop

**Date:** 2026-06-04
**Status:** Draft
**Topic:** Enhanced instrumentation for mempool, discovery, and execution with TUI visibility.

## 1. Overview
The goal is to enable a tight "run -> observe -> adjust" loop for debugging the bot's high-frequency operations. This is achieved by correlating mempool events with execution attempts and surfacing internal pipeline metrics in the TUI.

## 2. Architecture Changes

### 2.1. Mempool & Execution Trace IDs
*   **Trace Generation:** `MempoolService` will generate a 6-character `traceId` (e.g., `tx-8f2a`) for every swap-like transaction that passes basic filters.
*   **Propagation:**
    *   `MempoolSignal` (and its TUI event `mempool_pending_swap`) will carry `traceId`.
    *   `CandidateExecution` will store `traceId` if it was triggered by a mempool event.
*   **Logging:** All logs within a mempool-triggered pipeline pass will include the `traceId` in their context via child loggers.

### 2.2. Discovery Handover Metrics
*   **Metadata Expansion:** Discovery results will now include protocol counts (V2, V3, Balancer, etc.) and failure reasons (garbage, no-liquidity, missing-metadata).
*   **Bot-Indexer Sync:** Log the exact block height comparison between the bot's current graph state and the HyperIndex's last processed block during every discovery pass.

### 2.3. TUI Diagnostic Panels
*   **Mempool Panel:**
    *   Show "Active Trace IDs" with status indicators.
    *   Display `PendingStateOverlay` delta count.
    *   WebSocket health indicator (active/inactive/reconnecting).
*   **Index/Graph Panel:**
    *   Display "Graph Age" and "Discovery Lag" (blocks).
    *   Protocol distribution summary (e.g., `V2: 45 | V3: 12`).
*   **Execution Panel:**
    *   Display "Last Rejected Reason" for failed simulation candidates.
    *   Include Gas Price (Gwei) and Priority Fee Floor metrics.

## 3. Data Flow
1.  **Mempool Tx** -> `MempoolService` (Assign `traceId`) -> **Signal** -> `PassLoop`.
2.  `PassLoop` (if profitable) -> `CandidateBuilder` (Attach `traceId`) -> `ExecutionService`.
3.  `ExecutionService` (Log result with `traceId`) -> `TUI` (Update status for `traceId`).

## 4. Error Handling
*   Trace IDs are best-effort; if a loop is triggered by a timer (LF pass) rather than a signal, the `traceId` will be `timer-lf`.
*   TUI metrics should be updated at a frequency that doesn't cause terminal flicker (e.g., 500ms - 1s).

## 5. Verification Plan
*   **Manual:** Run the bot with `--tui` and verify that a large swap in the mempool (visible in logs/TUI) results in a tagged simulation entry.
*   **Logs:** Verify that `grep "tx-8f2a" runner.log` shows the full lifecycle from discovery/mempool to execution attempt.
