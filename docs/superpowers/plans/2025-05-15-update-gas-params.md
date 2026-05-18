# Update Gas Floor and Bidding Multipliers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the priority fee floor from 25 gwei to 30 gwei and the default max bidding multiplier from 3x to 5x in `src/execution/gas.ts`.

**Architecture:** Update constants and default values within `src/execution/gas.ts`.

**Tech Stack:** TypeScript, pnpm, git.

---

### Task 1: Update Priority Fee Floor

**Files:**
- Modify: `src/execution/gas.ts:251-255`

- [ ] **Step 1: Update the priority fee floor in `GasOracle.update`**

```typescript
<<<<
            // Clamp: never below 25 gwei (Polygon minimum for prompt inclusion),
            // never above 500 gwei (avoids outliers)
            const floor = 25n * 10n ** 9n;
====
            // Clamp: never below 30 gwei (Polygon minimum for prompt inclusion),
            // never above 500 gwei (avoids outliers)
            const floor = 30n * 10n ** 9n;
>>>>
```

- [ ] **Step 2: Verify the change**

Ensure the line now reads `const floor = 30n * 10n ** 9n;`.

- [ ] **Step 3: Commit the change**

```bash
git add src/execution/gas.ts
git commit -m "perf(gas): increase priority fee floor to 30 gwei"
```

### Task 2: Update Default Bidding Multipliers

**Files:**
- Modify: `src/execution/gas.ts:446-450`

- [ ] **Step 1: Update `maxMultiplierBps` default value in `scalePriorityFeeByProfitMargin`**

```typescript
<<<<
  const minMultiplierBps = BigInt(options.minMultiplierBps ?? 10_000n);
  const maxMultiplierBps = BigInt(options.maxMultiplierBps ?? 30_000n);
  const fullRampMarginBps = BigInt(options.fullRampMarginBps ?? 500n);
====
  const minMultiplierBps = BigInt(options.minMultiplierBps ?? 10_000n);
  const maxMultiplierBps = BigInt(options.maxMultiplierBps ?? 50_000n);
  const fullRampMarginBps = BigInt(options.fullRampMarginBps ?? 500n);
>>>>
```

- [ ] **Step 2: Verify the change**

Ensure the line now reads `const maxMultiplierBps = BigInt(options.maxMultiplierBps ?? 50_000n);`.

- [ ] **Step 3: Run typecheck**

Run: `pnpm run typecheck`

- [ ] **Step 4: Commit the change**

```bash
git add src/execution/gas.ts
git commit -m "perf(gas): increase default max bid to 5x"
```
