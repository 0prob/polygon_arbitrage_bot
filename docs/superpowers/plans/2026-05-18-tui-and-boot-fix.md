# TUI Progress, Telemetry, and Pool Discovery Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement TUI progress indicators, add telemetry to diagnose hangs, and fix the bot's bootup sequence to properly discover pools.

**Architecture:**
- Instrument `src/orchestrator/pass_loop.ts` to update `BotState.currentActivityProgress`.
- Add `ctx.logger.debug` statements in `pass_loop.ts` to identify hang points.
- Modify `src/orchestrator/boot.ts` to trigger discovery/hydration.
- Modify `src/orchestrator/pass_loop.ts` to trigger discovery if no pools are found.

**Tech Stack:** TypeScript, Node.js

---

### Task 1: Progress Instrumentation & Debug Logging

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Update pipeline evaluation loop for progress**

Modify `runPassLoop` in `src/orchestrator/pass_loop.ts` to update progress during the profitable pipeline evaluation loop.

```typescript
// Inside runPassLoop, before the loop iterating over `result.profitable`:
state.currentActivity = "Executing opportunities";
state.currentActivityDetail = `Processing ${result.profitable.length} opportunities`;
onStateUpdate?.(state);

for (const [index, profitable] of result.profitable.entries()) {
  state.currentActivityProgress = {
    label: "Executing",
    completed: index + 1,
    total: result.profitable.length,
    unit: "txs"
  };
  onStateUpdate?.(state);
  // ... existing execution logic ...
}
```

- [ ] **Step 2: Add Debug Logging for Hang Detection**

Add logging to identify the hang point in `src/orchestrator/pass_loop.ts`:

```typescript
// Around executionService.execute call
ctx.logger.debug({ routeKey }, "Starting execution");
const execResult = await ctx.executionService.execute(candidate);
ctx.logger.debug({ routeKey, success: execResult.success }, "Execution completed");
```

### Task 2: Fix Bootup Pool Discovery & Hydration

**Files:**
- Modify: `src/orchestrator/boot.ts`

- [ ] **Step 1: Trigger Pool Discovery and Hydration in `bootApplication`**

```typescript
// In src/orchestrator/boot.ts, near the end of bootApplication:
// ... after initializing services ...
  
  // Trigger pool discovery and hydration
  discoveryService.discoverProtocol("balancer").catch(logger.error);
  discoveryService.discoverProtocol("curve").catch(logger.error);
  
  await hydrationService.warmup(config.discovery.hubTokens);
  hydrationService.startSweep();

  return { /* ... */ };
```

### Task 3: Trigger Discovery in Pass Loop

**Files:**
- Modify: `src/orchestrator/pass_loop.ts`

- [ ] **Step 1: Trigger discovery if no pools found**

```typescript
// In pass_loop.ts, inside the loop where pools.length === 0
      if (pools.length === 0) {
        ctx.logger.info({}, "No pools found, triggering discovery");
        await ctx.discoveryService.discoverProtocol("balancer");
        await ctx.discoveryService.discoverProtocol("curve");
        // ...
        await sleep(intervalMs);
        continue;
      }
```

### Task 4: Verify and Commit

- [ ] **Step 1: Run Typecheck**
Run: `pnpm run typecheck`

- [ ] **Step 2: Run Tests**
Run: `pnpm test`

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/boot.ts src/orchestrator/pass_loop.ts
git commit -m "feat: implement progress instrumentation, telemetry, and fix pool discovery"
```
