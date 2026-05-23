# High-Performance Arbitrage Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the bot's core loop for higher frequency, better real-time instrumentation, and lower latency.

**Architecture:** 
1. Refactor PassRunner frequency.
2. Add TUI Profit/s metric.
3. Prepare WebSocket infrastructure.

---

### Task 1: Refactor PassRunner Frequency

**Files:**
- Modify: `src/orchestrator/runner.ts`
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Update PassRunner**
Implement multi-frequency triggering (200ms vs 1s).
- [ ] **Step 2: Commit**

### Task 2: Add TUI Profit/s Metric

**Files:**
- Modify: `src/tui/state.ts`
- Modify: `src/tui/renderer.ts`
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Instrument Profit/s**
Update state tracking to calculate profit per second based on `_startTime`.
- [ ] **Step 2: Update TUI renderer**
Display the new metric.
- [ ] **Step 3: Commit**

