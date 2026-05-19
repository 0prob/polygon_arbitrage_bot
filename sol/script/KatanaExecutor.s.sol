// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {KatanaExecutor} from "../src/KatanaExecutor.sol";

contract KatanaExecutorScript is Script {
    address internal constant DEFAULT_SUSHI_V2_FACTORY =
        0x72D111b4d6f31B38919ae39779f570b747d6Acd9;
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
