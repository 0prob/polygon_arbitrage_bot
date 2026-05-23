# Predictive Market Impact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement dynamic price impact estimation to prune unviable paths before full simulation.

**Architecture:**
1. Implement `getEffectivePriceImpact` in `simulator.ts`.
2. Integrate impact check into `pipeline.ts` as a filter.

**Tech Stack:** Bun, TypeScript.

---

### Task 1: Implement Impact Estimator
**Files:**
- Modify: `src/services/strategy/simulator.ts`
- Test: `src/services/strategy/simulator.test.ts`

- [ ] **Step 1: Implement getEffectivePriceImpact**
Implement `getEffectivePriceImpact(edge: SwapEdge, amountIn: bigint): number` which simulates a swap for the given amount and compares it against the spot price.
- [ ] **Step 2: Add tests**
Add test cases ensuring the impact increases predictably with `amountIn`.
- [ ] **Step 3: Commit**

### Task 2: Integrate into Pipeline
**Files:**
- Modify: `src/services/strategy/pipeline.ts`

- [ ] **Step 1: Integrate Filter**
Update `evaluatePipeline` to call `getEffectivePriceImpact` for each edge in a cycle. Prune the cycle if any edge exceeds the dynamically calculated impact threshold.
- [ ] **Step 2: Commit**

