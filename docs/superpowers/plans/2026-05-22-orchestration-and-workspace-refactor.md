# Orchestration and Workspace Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor workspace core orchestration (boot, loop, lifecycle) and standardize the `package.json` and build dependencies.

**Architecture:**
1. `BotSystem` container for services.
2. `Lifecycle` interface for service management.
3. `PassRunner` class for loop orchestration.
4. Cleaned up `package.json` with standardized scripts.

**Tech Stack:** Bun, Viem, Zod, Vitest.

---

### Task 1: Workspace Dependency Audit & Clean Up

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Audit dependencies**
Remove unused dev dependencies if any, verify versions.
- [ ] **Step 2: Update scripts**
Standardize scripts for `start`, `test`, `lint`, `fmt`. Consolidate Hyperindex tasks.
- [ ] **Step 3: Commit**

---

### Task 2: Core Lifecycle & Dependency Management

**Files:**
- Create: `src/orchestrator/lifecycle.ts` (Lifecycle Interface)
- Create: `src/orchestrator/system.ts` (`BotSystem` class)
- Modify: `src/orchestrator/boot.ts`

- [ ] **Step 1: Define Lifecycle Interface**
Create `Lifecycle` interface with `start`, `prepare`, `stop`.
- [ ] **Step 2: Implement BotSystem**
Create `BotSystem` class to manage services and provide `RuntimeContext`.
- [ ] **Step 3: Commit**

---

### Task 3: Loop Controller Refactor

**Files:**
- Create: `src/orchestrator/runner.ts` (`PassRunner` class)
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Implement PassRunner**
Extract the loop from `pass_loop.ts` into `PassRunner`.
- [ ] **Step 2: Connect Boot flow**
Update `cli/main.ts` to use `BotSystem` and `PassRunner`.
- [ ] **Step 3: Commit**

---

### Task 4: Standardize Test Harness

**Files:**
- Create: `tests/harness.ts`

- [ ] **Step 1: Implement BotTestHarness**
Create harness to mock `BotSystem` dependencies.
- [ ] **Step 2: Commit**

