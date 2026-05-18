# Workspace Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the repair of the workspace by fixing the `WatcherService` enrichment queue bug and verifying all other unstaged changes.

**Architecture:** 
- Fix the `drain` method in `WatcherService` to execute tasks before clearing the queue.
- Systematic verification of all modified files via typecheck, lint, and tests.
- Staging and committing the repaired state.

**Tech Stack:** TypeScript, Vitest, Foundry.

---

### Task 1: Fix WatcherService Drain

**Files:**
- Modify: `src/services/watcher/service.ts`

- [ ] **Step 1: Update drain method**

Modify `src/services/watcher/service.ts` to execute tasks in the enrichment queue during drain.

```typescript
<<<<
    drain: () => { this._enrichmentQueue.clear(); },
====
    drain: () => {
      for (const task of this._enrichmentQueue.values()) {
        try {
          task();
        } catch (err) {
          this.createRootLogger().error({ err }, "Enrichment task failed");
        }
      }
      this._enrichmentQueue.clear();
    },
>>>>
```

- [ ] **Step 2: Verify WatcherService types**

Ensure `WatcherEnrichmentQueue` in `src/services/watcher/types.ts` is consistent. (Already verified in research).

- [ ] **Step 3: Run Vitest to ensure no regressions**

Run: `pnpm test src/services/watcher/service.test.ts`
Expected: PASS

---

### Task 2: Final Verification & Commit

**Files:**
- All modified files in `src/`

- [ ] **Step 1: Run full typecheck**

Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: PASS (42 passed)

- [ ] **Step 3: Run Foundry tests**

Run: `cd sol && forge test --match-path test/ArbExecutorAtomic.t.sol`
Expected: PASS (3 passed)
Note: We skip Aave fork tests if they fail due to 429, but ensure atomic tests pass.

- [ ] **Step 4: Stage and commit all changes**

Run:
```bash
git add .
git commit -m "fix: repair watcher enrichment queue and finalize workspace improvements"
```

- [ ] **Step 5: Verify clean status**

Run: `git status`
Expected: "nothing to commit, working tree clean"
