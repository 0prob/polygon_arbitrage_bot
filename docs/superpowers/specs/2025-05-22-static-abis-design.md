# Design Spec: Static Base ABIs Centralization

## 1. Overview
This design aims to centralize and standardize the ABIs used across the project by moving them into a dedicated `src/core/abis/` directory and using TypeScript's `as const` for strict type safety.

## 2. Architecture
- **Location**: `src/core/abis/`
- **Pattern**: Exporting ABIs as `const` with `as const` assertion.

## 3. Components

### 3.1 Common ABIs (`src/core/abis/common.ts`)
Contains standard interfaces like ERC20.
- `ERC20_ABI`: `transfer`, `approve`, `balanceOf`.

### 3.2 Executor ABIs (`src/core/abis/executor.ts`)
Consolidates all functions and errors for the `ArbExecutor` contract into a single interface.
- `ARB_EXECUTOR_ABI`: Merged from `EXECUTOR_ABI`, `EXECUTOR_AAVE_ABI`, `EXECUTOR_APPROVE_IF_NEEDED_ABI`, and `EXECUTOR_TRANSFER_ALL_ABI`.

## 4. Implementation Details
The merged `ARB_EXECUTOR_ABI` will be a flat array of all members from the constituent ABIs. Since there are no name collisions among functions, a simple flat array is sufficient and efficient for type inference.

## 5. Testing
Verification will involve ensuring the files are correctly created and that the exported ABIs match the expected structure.
