# Static Base ABIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize ABI management by creating static base ABIs in `src/core/abis/`.

**Architecture:** Create a new directory `src/core/abis/` and export ABIs as `const ... as const` for strict TypeScript type safety.

**Tech Stack:** TypeScript

---

### Task 1: Create Common ABIs

**Files:**
- Create: `src/core/abis/common.ts`

- [ ] **Step 1: Create src/core/abis/common.ts with ERC20_ABI**

```typescript
export const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
```

### Task 2: Create Executor ABIs

**Files:**
- Create: `src/core/abis/executor.ts`

- [ ] **Step 1: Create src/core/abis/executor.ts by merging ABIs from src/services/execution/calldata/abis.ts**

```typescript
export const ARB_EXECUTOR_ABI = [
  {
    name: "executeArb",
    type: "function",
    inputs: [
      { name: "flashToken", type: "address" },
      { name: "flashAmount", type: "uint256" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "profitToken", type: "address" },
          { name: "minProfit", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "routeHash", type: "bytes32" },
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "data", type: "bytes" },
            ],
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "executeArbWithAave",
    type: "function",
    inputs: [
      { name: "flashToken", type: "address" },
      { name: "flashAmount", type: "uint256" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "profitToken", type: "address" },
          { name: "minProfit", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "routeHash", type: "bytes32" },
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "data", type: "bytes" },
            ],
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "approveIfNeeded",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "transferAll",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { name: "Unauthorized", type: "error", inputs: [] },
  { name: "DeadlineExpired", type: "error", inputs: [] },
  { name: "EmptyRoute", type: "error", inputs: [] },
  { name: "TooManyCalls", type: "error", inputs: [] },
  { name: "FlashLoanRequired", type: "error", inputs: [] },
  { name: "InvalidRouteHash", type: "error", inputs: [] },
  { name: "FlashLoanOnly", type: "error", inputs: [] },
  { name: "InvalidFlashLoanContext", type: "error", inputs: [] },
  { name: "CallbackOnly", type: "error", inputs: [] },
  { name: "InvalidCallbackSource", type: "error", inputs: [] },
  { name: "UnsupportedProtocol", type: "error", inputs: [{ name: "protocolId", type: "uint8" }] },
  {
    name: "InvalidPoolCaller",
    type: "error",
    inputs: [
      { name: "expected", type: "address" },
      { name: "actual", type: "address" },
    ],
  },
  {
    name: "ExternalCallFailed",
    type: "error",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "target", type: "address" },
      { name: "reason", type: "bytes" },
    ],
  },
  {
    name: "InsufficientProfit",
    type: "error",
    inputs: [
      { name: "finalBalance", type: "uint256" },
      { name: "requiredBalance", type: "uint256" },
    ],
  },
  {
    name: "TransferFailed",
    type: "error",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  {
    name: "ApproveFailed",
    type: "error",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
  },
  { name: "ZeroAddress", type: "error", inputs: [] },
] as const;
```

### Task 3: Commit Changes

- [ ] **Step 1: Commit the new files**

Run:
```bash
git add src/core/abis/common.ts src/core/abis/executor.ts
git commit -m "feat: add static base ABIs"
```
