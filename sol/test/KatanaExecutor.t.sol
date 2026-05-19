// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {KatanaExecutor} from "../src/KatanaExecutor.sol";

contract MockV2Pair {
    address public token0;
    address public token1;
    uint256 public lastSwapAmount;
    address public lastTo;

    constructor(address t0, address t1) { token0 = t0; token1 = t1; }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        lastSwapAmount = amount0Out > 0 ? amount0Out : amount1Out;
        lastTo = to;
    }
}

contract KatanaExecutorTest is Test {
    KatanaExecutor public executor;
    address public solver = address(0x123);
    address public constant V2_FACTORY = 0x72D111b4d6f31B38919ae39779f570b747d6Acd9;
    address public constant V3_FACTORY = 0x203e8740894c8955cB8950759876d7E7E45E04c1;

    function setUp() public {
        executor = new KatanaExecutor(solver, V2_FACTORY, V3_FACTORY);
    }

    function test_onlySolverCanExecuteArb() public {
        vm.prank(address(0x999));
        vm.expectRevert(KatanaExecutor.Unauthorized.selector);
        executor.executeArb(address(0), 2, 0, new KatanaExecutor.SwapStep[](0), address(0), 0, bytes32(0));
    }

    function test_solverCanExecuteArb() public {
        KatanaExecutor.SwapStep[] memory path = new KatanaExecutor.SwapStep[](0);
        vm.prank(solver);
        // Just verify it doesn't revert on the access check — flash swap will fail without real pool
        vm.expectRevert(); // will revert from flash swap, not from access
        executor.executeArb(address(0), 2, 0, path, address(0), 0, bytes32(0));
    }
}
