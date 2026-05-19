# Add Progress Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement progress instrumentation in the `runPassLoop` pipeline evaluation loop to provide better TUI feedback and debug potential hangs.

**Architecture:** Update `runPassLoop` in `src/orchestrator/pass_loop.ts` to populate `state.currentActivityProgress` during the profitable execution loop. Add debug logging for execution start/completion.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Create Test for Progress Instrumentation

**Files:**
- Create: `src/orchestrator/pass_loop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { runPassLoop } from "./pass_loop.ts";
import type { RuntimeContext } from "./boot.ts";

describe("runPassLoop", () => {
  it("updates currentActivityProgress during execution", async () => {
    // Mock RuntimeContext and dependencies
    // ...
    // Run pass loop
    // Assert onStateUpdate was called with expected progress
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orchestrator/pass_loop.test.ts`
Expected: FAIL (or not run, depending on implementation)

### Task 2: Implement Progress Instrumentation

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Update pipeline evaluation loop**

Modify `runPassLoop` to populate `state.currentActivityProgress`.

- [ ] **Step 2: Add Debug Logging for Hang Detection**

Add `ctx.logger.debug` around `ctx.executionService.execute(candidate)`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm test src/orchestrator/pass_loop.test.ts`
Expected: PASS
