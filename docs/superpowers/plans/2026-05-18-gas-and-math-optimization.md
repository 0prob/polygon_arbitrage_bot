# Gas and Math Optimization Implementation Plan

**Goal:** Improve accuracy, competitiveness, and performance of gas pricing, profit math, and Uniswap V3 simulations.

---

### Task 1: Fix Profit Calculation Bug and Standardize Rounding

**Files:**
- Modify: `src/arb/profit_compute.ts`

- [ ] **Step 1: Fix incorrect gas sanity check**
Change the comparison to use `gasCostInTokens` instead of `gasCost` (wei).

- [ ] **Step 2: Ensure ceiling rounding in `gasCostInTokenUnits`**
Verify `divRoundingUp` is used.

- [ ] **Step 3: Run unit tests**
Create/run a test to verify profit assessment with different token decimals.

---

### Task 2: Update Gas Floor and Bidding Multipliers

**Files:**
- Modify: `src/execution/gas.ts`

- [ ] **Step 1: Update priority fee floor to 30 gwei in `GasOracle.update`**

- [ ] **Step 2: Update default bidding multipliers to 5x in `scalePriorityFeeByProfitMargin`**

- [ ] **Step 3: Run typecheck**

---

### Task 3: Refine Price Oracle Staleness

**Files:**
- Modify: `src/arb/price_oracle.ts`

- [ ] **Step 1: Reduce `MATIC_USD_STALE_AFTER_MS` to 5 minutes**

---

### Task 4: Optimize Uniswap V3 Simulation Loop

**Files:**
- Modify: `src/math/uniswap_v3.ts`

- [ ] **Step 1: Refactor `simulateV3Swap` to minimize type conversions in the loop**

- [ ] **Step 2: Run benchmark (if available) or verify with typecheck**

---

### Task 5: Final Validation

- [ ] **Step 1: Full typecheck and lint**
- [ ] **Step 2: Run all tests**
