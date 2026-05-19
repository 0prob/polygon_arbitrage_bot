// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {CrossChainIntentOrigin} from "../src/CrossChainIntentOrigin.sol";

contract CrossChainIntentOriginScript is Script {
    function run() external returns (CrossChainIntentOrigin) {
        address bridge = vm.envAddress("BRIDGE");
        address katanaExecutorAddr = vm.envAddress("KATANA_EXECUTOR_ADDRESS");

        vm.startBroadcast();

        CrossChainIntentOrigin impl = new CrossChainIntentOrigin();
        bytes memory initData = abi.encodeCall(CrossChainIntentOrigin.initialize, (bridge, katanaExecutorAddr));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);

        vm.stopBroadcast();

        CrossChainIntentOrigin proxyContract = CrossChainIntentOrigin(address(proxy));

        console2.log("CrossChainIntentOrigin implementation:", address(impl));
        console2.log("CrossChainIntentOrigin proxy:", address(proxy));
        console2.log("bridge:", bridge);
        console2.log("katanaExecutor:", katanaExecutorAddr);

        return proxyContract;
    }
}
