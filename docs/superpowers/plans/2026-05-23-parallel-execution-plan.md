# Parallel Execution Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement parallel transaction submission for high-profit opportunities.

**Architecture:**
1. `ExecutionService` refactor to support multiple submitters (Relays).
2. Parallel broadcast of signed transactions via `Promise.any()` or `Promise.race()` against multiple endpoints.
3. Transaction tracking logic to handle concurrent submissions.

**Tech Stack:** Bun, Viem, TypeScript.

---

### Task 1: Refactor ExecutionService
**Files:**
- Modify: `src/services/execution/service.ts`

- [ ] **Step 1: Update execute method**
Update `execute` to accept a list of submitters (or a registry of relay endpoints).
- [ ] **Step 2: Implement Parallel Broadcast**
Use `Promise.any()` to race the submission attempts and return the first successful hash.
- [ ] **Step 3: Commit**

### Task 2: Relay Integration
**Files:**
- Modify: `src/infra/rpc/client_factory.ts`
- Modify: `src/orchestrator/boot.ts`

- [ ] **Step 1: Relay Factory**
Update client factory to support creating multiple execution clients for a list of relay URLs.
- [ ] **Step 2: Update BotSystem**
Initialize all relay clients in `BotSystem` and inject them into `ExecutionService`.
- [ ] **Step 3: Commit**

