// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {HuffDeployer} from "./HuffDeployer.sol";

contract ArbExecutorPrintTest is Test {
    function testDeployAndLog() public {
        bytes memory bytecode = abi.encodePacked(
            HuffDeployer.BYTECODE,
            abi.encode(
                address(0x1111),
                address(0x2222),
                address(0x3333),
                address(0x4444),
                address(0x5555),
                address(0x6666),
                address(0x7777),
                address(0x8888)
            )
        );
        address addr;
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        console.log("Deployed address:", addr);
        if (addr != address(0)) {
            console.log("Slot 0 (owner):", uint256(vm.load(addr, bytes32(uint256(0)))));
            console.log("Slot 7 (balancer):", uint256(vm.load(addr, bytes32(uint256(7)))));
            console.log("Slot 8 (uniV3):", uint256(vm.load(addr, bytes32(uint256(8)))));
            console.log("Slot 9 (sushi):", uint256(vm.load(addr, bytes32(uint256(9)))));
            console.log("Slot 10 (quick):", uint256(vm.load(addr, bytes32(uint256(10)))));
            console.log("Slot 11 (kyber):", uint256(vm.load(addr, bytes32(uint256(11)))));
            console.log("Slot 12 (aave):", uint256(vm.load(addr, bytes32(uint256(12)))));
            console.log("Slot 13 (manager):", uint256(vm.load(addr, bytes32(uint256(13)))));
            console.log("Slot 6 (locked):", uint256(vm.load(addr, bytes32(uint256(6)))));
        }
    }
}
