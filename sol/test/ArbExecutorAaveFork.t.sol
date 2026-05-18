// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ArbExecutor, IERC20Minimal} from "../src/ArbExecutor.sol";
import {Test} from "forge-std/Test.sol";

contract ArbExecutorAaveForkTest is Test {
    ArbExecutor public executor;

    // Polygon mainnet addresses
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant UNISWAP_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address constant SUSHISWAP_V3_FACTORY = 0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2;
    address constant QUICKSWAP_V3_FACTORY = 0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28;
    address constant KYBER_ELASTIC_FACTORY = 0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a;
    address constant WMATIC = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270;
    address constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string("https://polygon-mainnet.g.alchemy.com/v2/demo"));
        vm.createSelectFork(rpc);

        executor = new ArbExecutor(
            address(this),
            BALANCER_VAULT,
            UNISWAP_V3_FACTORY,
            SUSHISWAP_V3_FACTORY,
            QUICKSWAP_V3_FACTORY,
            KYBER_ELASTIC_FACTORY,
            AAVE_POOL
        );
    }

    function testAavePoolAddress() public {
        assertEq(executor.aavePool(), AAVE_POOL);
    }

    function testAavePoolInterfaceGetReserveData() public {
        // Verify the Aave Pool address is a real contract with the expected interface
        // by calling getReserveData() via staticcall on USDC
        (bool ok, bytes memory result) = AAVE_POOL.staticcall(
            abi.encodeWithSignature("getReserveData(address)", USDC)
        );
        assertTrue(ok, "getReserveData staticcall failed");
        // Return data for a reserve should be > 0 bytes (at least one uint256)
        assertGt(result.length, 32, "getReserveData returned too little data");
    }

    function testExecuteOperationRevertsWithFlashLoanOnly() public {
        // Directly calling executeOperation (not via Aave flash loan) should revert
        // with FlashLoanOnly because msg.sender != aavePool
        vm.expectRevert(ArbExecutor.FlashLoanOnly.selector);
        executor.executeOperation(USDC, 1000, 0, address(this), "");
    }

    function testExecuteArbWithAaveRevertsWithEmptyRoute() public {
        ArbExecutor.Call[] memory calls;
        ArbExecutor.FlashParams memory params = ArbExecutor.FlashParams({
            profitToken: USDC,
            minProfit: 0,
            deadline: block.timestamp + 1 days,
            routeHash: keccak256(abi.encode(calls)),
            calls: calls
        });

        vm.expectRevert(ArbExecutor.EmptyRoute.selector);
        executor.executeArbWithAave(USDC, 1000, params);
    }

    function testExecuteArbWithAaveRevertsIfNotAuthorized() public {
        ArbExecutor.Call[] memory calls;
        ArbExecutor.FlashParams memory params = ArbExecutor.FlashParams({
            profitToken: USDC,
            minProfit: 0,
            deadline: block.timestamp + 1 days,
            routeHash: keccak256(abi.encode(calls)),
            calls: calls
        });

        // Call from a non-owner, non-operator address
        vm.prank(address(0xdeadbeef));
        vm.expectRevert(ArbExecutor.Unauthorized.selector);
        executor.executeArbWithAave(USDC, 1000, params);
    }

    function testAavePoolIsContract() public {
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(AAVE_POOL)
        }
        assertGt(codeSize, 0, "Aave Pool must be a deployed contract on the forked chain");
    }
}
