# Remove Operator Functionality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "operator" role from the `ArbExecutor` contract and its deployment scripts, leaving the `owner` as the sole authorized address for execution and management.

**Architecture:** Simplify access control by removing the `operators` mapping and redefining `onlyAuthorized` to check only the `owner`. Remove all associated management functions and deployment-time configurations.

**Tech Stack:** Solidity (Foundry), Forge Scripts.

---

### Task 1: Update ArbExecutor.sol

**Files:**

- Modify: `src/ArbExecutor.sol`

- [ ] **Step 1: Establish baseline by running tests**

Run: `forge test`
Expected: PASS

- [ ] **Step 2: Remove operator-related state and events**

Remove the `OperatorSet` event and `operators` mapping.

```solidity
<<<<
    event OperatorSet(address indexed operator, bool allowed);
====
>>>>
<<<<
    mapping(address => bool) public operators;
====
>>>>
```

- [ ] **Step 3: Redefine onlyAuthorized modifier**

Simplify the modifier to only check for the `owner`.

```solidity
<<<<
    modifier onlyAuthorized() {
        if (msg.sender != owner && !operators[msg.sender]) revert Unauthorized();
        _;
    }
====
    modifier onlyAuthorized() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }
>>>>
```

- [ ] **Step 4: Remove setOperator function**

```solidity
<<<<
    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }
====
>>>>
```

- [ ] **Step 5: Update approveIfNeeded logic**

Remove the operator check in `approveIfNeeded`.

```solidity
<<<<
    function approveIfNeeded(address token, address spender, uint256 amount) external nonReentrant {
        if (msg.sender != address(this) && msg.sender != owner && !operators[msg.sender]) {
            revert Unauthorized();
        }
        _safeApproveMaxIfNeeded(token, spender, amount);
    }
====
    function approveIfNeeded(address token, address spender, uint256 amount) external nonReentrant {
        if (msg.sender != address(this) && msg.sender != owner) {
            revert Unauthorized();
        }
        _safeApproveMaxIfNeeded(token, spender, amount);
    }
>>>>
```

- [ ] **Step 6: Run tests to verify logic**

Run: `forge test`
Expected: PASS (Unauthorized checks should still pass as they use non-owner addresses).

- [ ] **Step 7: Commit changes**

```bash
git add src/ArbExecutor.sol
git commit -m "refactor: remove operator role from ArbExecutor"
```

### Task 2: Update Deployment Scripts

**Files:**

- Modify: `script/ArbExecutor.s.sol`
- Modify: `script/DeployAmoy.s.sol`

- [ ] **Step 1: Update script/ArbExecutor.s.sol**

Remove `initialOperator` and its usage.

```solidity
<<<<
        address initialOperator = vm.envOr("INITIAL_OPERATOR", address(0));

        vm.startBroadcast();
...
        // Post-deployment operator setup (only works if broadcaster == owner)
        if (initialOperator != address(0)) {
            if (msg.sender == owner) {
                executor.setOperator(initialOperator, true);
                console2.log("Initial operator granted:", initialOperator);
            } else {
                console2.log("NOTE: INITIAL_OPERATOR was provided but broadcaster != owner.");
                console2.log("      Call setOperator(operator, true) manually from the owner account.");
            }
        }

        vm.stopBroadcast();

        console2.log("ArbExecutor deployed:", address(executor));
        console2.log("owner:", owner);
        if (initialOperator != address(0) && msg.sender == owner) {
            console2.log("operator:", initialOperator);
        }
====
        vm.startBroadcast();
...
        vm.stopBroadcast();

        console2.log("ArbExecutor deployed:", address(executor));
        console2.log("owner:", owner);
>>>>
```

- [ ] **Step 2: Update script/DeployAmoy.s.sol**

Apply similar removals to `DeployAmoy.s.sol`.

- [ ] **Step 3: Verify scripts compile**

Run: `forge build`
Expected: SUCCESS

- [ ] **Step 4: Commit changes**

```bash
git add script/ArbExecutor.s.sol script/DeployAmoy.s.sol
git commit -m "refactor: remove operator configuration from deployment scripts"
```

### Task 3: Final Verification

- [ ] **Step 1: Run all tests one last time**

Run: `forge test`
Expected: PASS

- [ ] **Step 2: Dry-run deployment script**

Run: `OWNER=0x0000000000000000000000000000000000000001 forge script script/ArbExecutor.s.sol`
Expected: SUCCESS (Dry run should finish without errors).
