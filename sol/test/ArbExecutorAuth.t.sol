// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";

contract ArbExecutorAuthTest is Test {
    ArbExecutor public executor;
    address public owner = address(0x1);
    address public notOwner = address(0x2);

    function setUp() public {
        vm.prank(owner);
        executor = new ArbExecutor(
            owner,
            address(0x1000),
            address(0x1001),
            address(0x1002),
            address(0x1003),
            address(0x1004),
            address(0x1005),
            address(0x1006)
        );
    }

    function test_OnlyOwnerCanExecuteArb() public {
        ArbExecutor.Call[] memory calls = new ArbExecutor.Call[](1);
        calls[0] = ArbExecutor.Call({target: address(0xdead), value: 0, data: ""});
        ArbExecutor.FlashParams memory params = ArbExecutor.FlashParams({
            profitToken: address(0xbeef),
            minProfit: 0,
            deadline: block.timestamp + 1 days,
            routeHash: keccak256(abi.encode(calls)),
            calls: calls
        });

        // Non-owner should revert
        vm.prank(notOwner);
        vm.expectRevert(ArbExecutor.Unauthorized.selector);
        executor.executeArb(address(0xcafe), 100, params);

        // Owner should NOT revert with Unauthorized (it might revert with something else due to mock addresses, but not Unauthorized)
        vm.prank(owner);
        try executor.executeArb(address(0xcafe), 100, params) {
        // success or other revert
        }
        catch (bytes memory reason) {
            // Check that it's NOT Unauthorized
            bytes4 unauthorizedSelector = ArbExecutor.Unauthorized.selector;
            bytes4 receivedSelector;
            if (reason.length >= 4) {
                assembly {
                    receivedSelector := mload(add(reason, 32))
                }
            }
            assertTrue(receivedSelector != unauthorizedSelector, "Should not be unauthorized");
        }
    }

    function test_ApproveIfNeeded_Auth() public {
        // Owner should be able to call it
        vm.prank(owner);
        try executor.approveIfNeeded(address(0xcafe), address(0xface), 100) {}
        catch (bytes memory reason) {
            bytes4 unauthorizedSelector = ArbExecutor.Unauthorized.selector;
            bytes4 receivedSelector;
            if (reason.length >= 4) {
                assembly {
                    receivedSelector := mload(add(reason, 32))
                }
            }
            assertTrue(receivedSelector != unauthorizedSelector, "Owner should not be unauthorized");
        }

        // Non-owner should revert
        vm.prank(notOwner);
        vm.expectRevert(ArbExecutor.Unauthorized.selector);
        executor.approveIfNeeded(address(0xcafe), address(0xface), 100);
    }

    function test_PreApprove_Auth() public {
        // Non-owner should revert
        vm.prank(notOwner);
        vm.expectRevert(ArbExecutor.Unauthorized.selector);
        executor.preApprove(address(0xcafe), address(0xface));
    }
}
