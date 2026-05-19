// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CrossChainIntentOrigin} from "../src/CrossChainIntentOrigin.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MockERC20 is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    function transfer(address to, uint256 amount) external override returns (bool) { balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true; }
    function approve(address spender, uint256 amount) external override returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; totalSupply += amount; }
}

contract CrossChainIntentOriginTest is Test {
    CrossChainIntentOrigin public origin;
    MockERC20 public weth;
    address public solver = address(0x123);
    address public fillAddress = address(0x456);
    address public bridge = address(0x789);

    function setUp() public {
        weth = new MockERC20();
        weth.mint(solver, 100e18);
        CrossChainIntentOrigin impl = new CrossChainIntentOrigin();
        bytes memory initData = abi.encodeCall(CrossChainIntentOrigin.initialize, (bridge, fillAddress));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        origin = CrossChainIntentOrigin(address(proxy));
    }

    function test_executeArbOrder_escrowsTokens() public {
        vm.startPrank(solver);
        weth.approve(address(origin), 10e18);
        bytes memory orderData = abi.encode(fillAddress, block.timestamp + 1 hours, hex"dead", fillAddress, 100e18);
        bytes32 orderId = origin.executeArbOrder(address(weth), 10e18, orderData);
        vm.stopPrank();

        (address token, uint256 amount, address escrowSolver, , , bool claimed) = origin.vaults(orderId);
        assertEq(token, address(weth));
        assertEq(amount, 10e18);
        assertEq(escrowSolver, solver);
        assertFalse(claimed);
        assertEq(weth.balanceOf(address(origin)), 10e18);
        assertEq(weth.balanceOf(solver), 90e18);
    }

    function test_claimOrder_releasesEscrow() public {
        vm.startPrank(solver);
        weth.approve(address(origin), 10e18);
        bytes memory orderData = abi.encode(fillAddress, block.timestamp + 1 hours, hex"dead", fillAddress, 100e18);
        bytes32 orderId = origin.executeArbOrder(address(weth), 10e18, orderData);
        vm.stopPrank();

        // Simulate AggLayer proof — in real impl this calls bridge.proveTransaction()
        vm.prank(solver);
        origin.claimOrder(orderId, hex"");
        (, , , , , bool claimedAfter) = origin.vaults(orderId);
        assertTrue(claimedAfter);
        assertEq(weth.balanceOf(solver), 100e18);
        assertEq(weth.balanceOf(address(origin)), 0);
    }
}
