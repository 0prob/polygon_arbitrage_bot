# ExecutionService Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `ExecutionService` to support multiple submission endpoints and parallel execution.

**Architecture:** Update `ExecutionService` to accept an array of submit functions and use `Promise.any()` to broadcast transactions to all endpoints concurrently, racing for the first successful submission.

**Tech Stack:** TypeScript, Node.js, viem (implied)

---

### Task 1: Update ExecutionService Constructor and Method Signature

**Files:**
- Modify: `src/services/execution/service.ts`
- Test: `src/services/execution/service.test.ts`

- [ ] **Step 1: Update constructor to accept array of submit functions**

Update `ExecutionService` constructor to change `submitTx` from a single function to an array of functions:
```typescript
  constructor(
    private logger: Logger,
    private gasOracle: GasOracle,
    private nonceManager: NonceManager,
    private submitTx: ((tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }) => Promise<string>)[],
  ) {}
```

- [ ] **Step 2: Update execute method to broadcast via Promise.any()**

```typescript
  async execute(candidate: CandidateExecution): Promise<ExecutionResult> {
    if (this.quarantine.has(candidate.routeKey)) {
      return { success: false, error: "route quarantined" };
    }

    try {
      const fee = this.gasOracle.getSnapshot();
      if (!fee) {
        this._addQuarantine(candidate.routeKey);
        return { success: false, error: "no gas data" };
      }

      const nonce = this.nonceManager.getNextNonce();
      
      // Broadcast to all endpoints concurrently
      const txHash = await Promise.any(
        this.submitTx.map(submit => submit({
          to: candidate.targetAddress,
          data: candidate.calldata,
          value: candidate.value,
          nonce,
          maxFee: fee.maxFee,
        }))
      );

      this.nonceManager.confirmNonce(nonce).catch(() => {});
      this.logger.info({ txHash, routeKey: candidate.routeKey }, "Transaction submitted");
      return { success: true, txHash };
    } catch (err) {
      const msg = err instanceof AggregateError 
        ? err.errors.map(e => (e instanceof Error ? e.message : String(e))).join(", ")
        : (err instanceof Error ? err.message : String(err));
      this._addQuarantine(candidate.routeKey);
      return { success: false, error: msg };
    }
  }
```

- [ ] **Step 3: Update existing tests in `service.test.ts` to accommodate the array change.**

- [ ] **Step 4: Run tests**

Run: `npm run test src/services/execution/service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/execution/service.ts src/services/execution/service.test.ts
git commit -m "feat: execution service supports multi-endpoint submission"
```

### Task 2: Update Application Boot

**Files:**
- Modify: `src/orchestrator/boot.ts`

- [ ] **Step 1: Update boot logic to provide an array of submit functions**

Modify `bootApplication` in `src/orchestrator/boot.ts` to pass an array of submission functions. Since we only have one currently, we'll wrap the existing `submitTx` in an array.

```typescript
  const submitTx = async (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }): Promise<string> => {
     // ...
  };

  const executionService = new ExecutionService(logger, gasOracle, nonceManager, [submitTx]);
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator/boot.ts
git commit -m "refactor: update boot to provide array of submit functions"
```
