# Live Diagnostic Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Trace IDs for correlating mempool events with execution, expand discovery metrics, and enhance the TUI with diagnostic panels to enable a tight feedback loop.

**Architecture:** We will generate `traceId`s in the `MempoolService`, propagate them through the `PassLoop` into `ExecutionService`, and surface everything via the TUI's `EventBus`. Discovery metrics will be expanded to include protocol-level counts and block lag.

**Tech Stack:** TypeScript, Bun, Pino (logging), Viem (types), Custom TUI.

---

### Task 1: Add Trace IDs to Mempool Signals

**Files:**
- Modify: `src/services/mempool/signals.ts`
- Modify: `src/services/mempool/service.ts`
- Test: `src/services/mempool/service.test.ts`

- [ ] **Step 1: Update MempoolSignal types**

Add `traceId` to `LargeSwapSignal` and `NewPoolSignal`.

```typescript
// src/services/mempool/signals.ts
export interface LargeSwapSignal {
  type: "large_swap";
  traceId: string; // Add this
  data: { ... };
}
```

- [ ] **Step 2: Generate traceId in MempoolService**

Update `processPendingTx` to generate a short ID.

```typescript
// src/services/mempool/service.ts
processPendingTx(tx: { hash: string; ... }) {
  const traceId = `tx-${tx.hash.slice(2, 8)}`;
  // ... pass traceId to this.emit()
}
```

- [ ] **Step 3: Update MempoolService tests**

Ensure tests verify the presence of `traceId`.

- [ ] **Step 4: Commit**

```bash
git add src/services/mempool/
git commit -m "feat(mempool): add traceId to swap signals"
```

---

### Task 2: Propagate Trace IDs to Execution

**Files:**
- Modify: `src/services/execution/candidate.ts`
- Modify: `src/orchestrator/pass_loop.ts`
- Modify: `src/tui/events.ts`

- [ ] **Step 1: Update CandidateExecution type**

Add `traceId` to the execution candidate.

- [ ] **Step 2: Wire Trace ID in PassLoop**

Ensure that when a `LargeSwapSignal` is received, the resulting re-simulation uses that `traceId`.

- [ ] **Step 3: Update TUI events**

Update `mempool_pending_swap` event to include `traceId`.

- [ ] **Step 4: Commit**

```bash
git add src/services/execution/ src/orchestrator/ src/tui/events.ts
git commit -m "feat(exec): propagate traceId from mempool to execution"
```

---

### Task 3: Expand Discovery Metrics

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`
- Modify: `src/tui/events.ts`

- [ ] **Step 1: Track protocol counts in runPoolDiscovery**

Aggregate counts of V2, V3, etc., during the Hasura fetch.

- [ ] **Step 2: Emit discovery_summary event**

Add a new event type to `EventBus` that carries these counts and block lag.

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/pass_loop.ts src/tui/events.ts
git commit -m "feat(discovery): track and emit protocol-level metrics"
```

---

### Task 4: Enhance TUI Diagnostics

**Files:**
- Modify: `src/tui/state.ts`
- Modify: `src/tui/renderer.ts`

- [ ] **Step 1: Update TuiState**

Add fields for `activeTraces`, `protocolCounts`, `lastRejectReason`, and `gasMetrics`.

- [ ] **Step 2: Implement Trace ID list in Mempool Panel**

Render a scrolling list of recent `traceId`s and their status.

- [ ] **Step 3: Implement Discovery Summary in Index Panel**

Render the protocol breakdown and lag blocks.

- [ ] **Step 4: Implement Rejection Reason in Exec Panel**

Show why the last candidate was rejected.

- [ ] **Step 5: Commit**

```bash
git add src/tui/state.ts src/tui/renderer.ts
git commit -m "feat(tui): add diagnostic panels and metric rendering"
```
