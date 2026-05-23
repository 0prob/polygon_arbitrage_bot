# TUI Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the TUI into a modular grid dashboard displaying real-time component health, sync progress, and arbitrage statistics.

**Architecture:** 
1. Expand `ArbEvent` and `TuiState` for new metrics.
2. Update `layout.ts` to support dynamic grid regions.
3. Add instrumentation in bot services for component events.

**Tech Stack:** Bun/TypeScript, ANSI terminal rendering.

---

### Task 1: Update Event System and State Model

**Files:**
- Modify: `src/tui/events.ts`
- Modify: `src/tui/state.ts`
- Test: `tests/tui/state.test.ts`

- [ ] **Step 1: Add new events**
Update `ArbEvent` in `src/tui/events.ts` to include:
  `HyperindexStatus`, `ExecutionStatus`, `ComponentHealth`, `CurrentAction`.

- [ ] **Step 2: Update state model**
Add relevant fields to `TuiState` in `src/tui/state.ts` (e.g., `syncProgress`, `componentHealth`, `currentAction`).

- [ ] **Step 3: Run state tests**
Run `bun test tests/tui/state.test.ts`

---

### Task 2: Implement Grid Layout Logic

**Files:**
- Modify: `src/tui/layout.ts`
- Test: `tests/tui/layout.test.ts`

- [ ] **Step 1: Refactor layout**
Update `src/tui/layout.ts` to calculate grid zones instead of row-based panels.

- [ ] **Step 2: Run layout tests**
Run `bun test tests/tui/layout.test.ts`

---

### Task 3: Update Renderer and Main Instrumentation

**Files:**
- Modify: `src/tui/renderer.ts`
- Modify: `src/tui/main.ts`
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Update renderer**
Update `Renderer` to iterate through grid zones defined by `layout.ts` and render updated state.

- [ ] **Step 2: Add instrumentation**
Add event emissions to `src/orchestrator/pass_loop.ts` for new status events.

- [ ] **Step 3: Run integration tests**
Run `bun test tests/tui/main.test.ts tests/tui/renderer.test.ts`

