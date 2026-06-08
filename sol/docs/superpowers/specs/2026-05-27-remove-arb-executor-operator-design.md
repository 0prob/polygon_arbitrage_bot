# Design Doc: Remove Operator Functionality from ArbExecutor

## 1. Overview

The `ArbExecutor` contract currently supports an "operator" role, allowing addresses other than the owner to execute arbitrage transactions and manage token approvals. This design document outlines the removal of this role to simplify the contract's access control, leaving the `owner` as the sole authorized executor.

## 2. Proposed Changes

### 2.1. `src/ArbExecutor.sol`

- **State & Events**:
  - Remove `mapping(address => bool) public operators;`.
  - Remove `event OperatorSet(address indexed operator, bool allowed);`.
- **Modifiers**:
  - Update `onlyAuthorized` to only permit the `owner`.
  - Note: The `onlyOwner` modifier already exists and can be reused where appropriate, but `onlyAuthorized` is used in many places and its redefinition to match `onlyOwner` is the most surgical change.
- **Functions**:
  - Remove `setOperator(address operator, bool allowed)`.
  - Update `approveIfNeeded(address token, address spender, uint256 amount)`:
    - Remove the check for `operators[msg.sender]`.
    - Resulting check: `if (msg.sender != address(this) && msg.sender != owner)`.

### 2.2. Deployment Scripts

- **`script/ArbExecutor.s.sol`** and **`script/DeployAmoy.s.sol`**:
  - Remove `initialOperator` local variable and its initialization from environment variables.
  - Remove the post-deployment block that calls `executor.setOperator(...)`.
  - Remove console logs related to the operator.

## 3. Impact Assessment

### 3.1. Security

- The attack surface is reduced by removing an additional role that could be granted permissions.
- Access control remains robust as the `owner` still retains full control over arbitrage execution and rescue operations.

### 3.2. Gas Efficiency

- Removing the `operators` mapping and the `setOperator` function reduces the contract's deployment size and slightly reduces execution gas for `onlyAuthorized` calls (one less storage read).

### 3.3. Breaking Changes

- Any external system or bot relying on an "operator" address (different from the owner) will no longer be able to call `executeArb`, `executeArbWithAave`, `preApprove`, or `approveIfNeeded`.

## 4. Verification Plan

### 4.1. Automated Tests

- Run existing tests: `forge test`.
- Verify that tests checking for "unauthorized" access still pass (e.g., `testExecuteArbWithAaveRevertsIfNotAuthorized`).
- Verify that owner-only operations still work as expected.

### 4.2. Deployment Verification

- Run a dry-run of the deployment script to ensure it compiles and executes without errors:
  - `forge script script/ArbExecutor.s.sol`
