# Deploy Scripts & Envio Codegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Forge deploy scripts for KatanaExecutor and CrossChainIntentOrigin contracts, fix envio HyperSync config for chain 747474, and run codegen.

**Architecture:** Two new Foundry `.s.sol` scripts following the existing `ArbExecutor.s.sol` pattern, an enhanced bash deploy script, and a config fix to the HyperIndex config.

**Tech Stack:** Foundry (forge), Solidity, Bash, Envio/HyperIndex

---

### Task 1: Add HyperSync endpoint for Katana in envio config

**Files:**
- Modify: `hyperindex/config.yaml:108-131`

- [ ] **Edit config.yaml to add hypersync_config under chain 747474**

```yaml
  - id: 747474
    start_block: 0
    hypersync_config:
      url: https://katana.hypersync.xyz
    contracts:
```

- [ ] **Run envio codegen**

Run: `cd hyperindex && bunx envio codegen`
Expected output: codegen completes without errors, generates types for chain 747474 entities.

- [ ] **Commit**

```bash
git add hyperindex/config.yaml
git commit -m "fix(hyperindex): add hypersync endpoint for Katana chain 747474"
```

---

### Task 2: Create KatanaExecutor deploy script

**Files:**
- Create: `sol/script/KatanaExecutor.s.sol`

- [ ] **Create KatanaExecutor.s.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {KatanaExecutor} from "../src/KatanaExecutor.sol";

contract KatanaExecutorScript is Script {
    address internal constant DEFAULT_SUSHI_V2_FACTORY =
        0x72d111b4d6f31b38919ae39779f570b747d6acd9;
    address internal constant DEFAULT_SUSHI_V3_FACTORY =
        0x203e8740894c8955cB8950759876d7E7E45E04c1;

    function run() external returns (KatanaExecutor executor) {
        address solver = vm.envAddress("SOLVER");
        address sushiV2Factory = vm.envOr("SUSHI_V2_FACTORY", DEFAULT_SUSHI_V2_FACTORY);
        address sushiV3Factory = vm.envOr("SUSHI_V3_FACTORY", DEFAULT_SUSHI_V3_FACTORY);

        vm.startBroadcast();
        executor = new KatanaExecutor(solver, sushiV2Factory, sushiV3Factory);
        vm.stopBroadcast();

        console2.log("KatanaExecutor deployed:", address(executor));
        console2.log("solver:", solver);
        console2.log("sushiV2Factory:", sushiV2Factory);
        console2.log("sushiV3Factory:", sushiV3Factory);
    }
}
```

- [ ] **Commit**

```bash
git add sol/script/KatanaExecutor.s.sol
git commit -m "feat(contract): add KatanaExecutor deploy script"
```

---

### Task 3: Create CrossChainIntentOrigin deploy script

**Files:**
- Create: `sol/script/CrossChainIntentOrigin.s.sol`

- [ ] **Create CrossChainIntentOrigin.s.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CrossChainIntentOrigin} from "../src/CrossChainIntentOrigin.sol";

contract CrossChainIntentOriginScript is Script {
    function run() external returns (address proxyAddr) {
        address bridge = vm.envAddress("BRIDGE");
        address katanaExecutor = vm.envAddress("KATANA_EXECUTOR_ADDRESS");

        vm.startBroadcast();

        CrossChainIntentOrigin implementation = new CrossChainIntentOrigin();
        console2.log("Implementation deployed:", address(implementation));

        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeWithSelector(
                CrossChainIntentOrigin.initialize.selector,
                bridge,
                katanaExecutor
            )
        );
        proxyAddr = address(proxy);

        vm.stopBroadcast();

        console2.log("CrossChainIntentOrigin deployed:", proxyAddr);
        console2.log("bridge:", bridge);
        console2.log("katanaExecutor:", katanaExecutor);
    }
}
```

- [ ] **Commit**

```bash
git add sol/script/CrossChainIntentOrigin.s.sol
git commit -m "feat(contract): add CrossChainIntentOrigin deploy script"
```

---

### Task 4: Enhance sol/deploy bash script

**Files:**
- Modify: `sol/deploy`

- [ ] **Update sol/deploy to accept contract name argument**

```bash
#!/usr/bin/env bash
set -euo pipefail

contract="${1:-}"

case "$contract" in
  arb)
    : "${RPC_URL:?RPC_URL not set}"
    : "${PRIVATE_KEY:?PRIVATE_KEY not set}"
    : "${OWNER:?OWNER not set}"
    exec forge script script/ArbExecutor.s.sol \
      --rpc-url "$RPC_URL" \
      --private-key "$PRIVATE_KEY" \
      --broadcast
    ;;
  katana)
    : "${KATANA_RPC_URL:?KATANA_RPC_URL not set}"
    : "${PRIVATE_KEY:?PRIVATE_KEY not set}"
    : "${SOLVER:?SOLVER not set}"
    exec forge script script/KatanaExecutor.s.sol \
      --rpc-url "$KATANA_RPC_URL" \
      --private-key "$PRIVATE_KEY" \
      --broadcast
    ;;
  origin)
    : "${RPC_URL:?RPC_URL not set}"
    : "${PRIVATE_KEY:?PRIVATE_KEY not set}"
    : "${BRIDGE:?BRIDGE not set}"
    : "${KATANA_EXECUTOR_ADDRESS:?KATANA_EXECUTOR_ADDRESS not set}"
    exec forge script script/CrossChainIntentOrigin.s.sol \
      --rpc-url "$RPC_URL" \
      --private-key "$PRIVATE_KEY" \
      --broadcast
    ;;
  *)
    echo "Usage: $0 {arb|katana|origin}"
    echo ""
    echo "  arb      Deploy ArbExecutor (Polygon). Requires: RPC_URL, PRIVATE_KEY, OWNER"
    echo "  katana   Deploy KatanaExecutor (Katana). Requires: KATANA_RPC_URL, PRIVATE_KEY, SOLVER"
    echo "  origin   Deploy CrossChainIntentOrigin (Polygon). Requires: RPC_URL, PRIVATE_KEY, BRIDGE, KATANA_EXECUTOR_ADDRESS"
    exit 1
    ;;
esac
```

- [ ] **Make deploy script executable**

Run: `chmod +x sol/deploy`

- [ ] **Commit**

```bash
git add sol/deploy
git commit -m "feat(contract): enhance deploy script with katana + origin targets"
```
