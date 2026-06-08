// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ArbExecutor, IERC20Minimal, IFlashLoanRecipient} from "../src/ArbExecutor.sol";
import {HuffDeployer} from "./HuffDeployer.sol";

contract MockToken is IERC20Minimal {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return balances[account];
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balances[msg.sender] >= amount, "insufficient balance");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }
}

contract CallbackVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20Minimal[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        require(tokens.length == 1 && amounts.length == 1, "single token only");
        MockToken(address(tokens[0])).mint(address(recipient), amounts[0]);
        uint256[] memory fees = new uint256[](1);
        recipient.receiveFlashLoan(tokens, amounts, fees, userData);
    }
}

contract NoCallbackVault {
    function flashLoan(IFlashLoanRecipient, IERC20Minimal[] memory, uint256[] memory, bytes memory) external pure {
        // Malformed vault for boundary testing: returns without invoking receiveFlashLoan.
    }
}

contract RecorderTarget {
    uint256 public count;

    function record() external {
        count += 1;
    }
}

contract RevertingTarget {
    function fail() external pure {
        revert("route call failed");
    }
}

contract ArbExecutorAtomicTest {
    MockToken internal token;
    RecorderTarget internal recorder;
    RevertingTarget internal reverter;

    function _deployExecutor(address vault) internal returns (ArbExecutor) {
        bytes memory bytecode = abi.encodePacked(
            HuffDeployer.BYTECODE,
            abi.encode(
                address(this),
                vault,
                address(0x1001),
                address(0x1002),
                address(0x1003),
                address(0x1004),
                address(0x1005),
                address(0x1006)
            )
        );
        address addr;
        assembly {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), "deploy failed");
        return ArbExecutor(payable(addr));
    }

    function _baseCalls(uint256 count) internal view returns (ArbExecutor.Call[] memory calls) {
        calls = new ArbExecutor.Call[](count);
        calls[0] = ArbExecutor.Call({
            target: address(recorder), value: 0, data: abi.encodeWithSelector(RecorderTarget.record.selector)
        });
        if (count > 1) {
            calls[1] = ArbExecutor.Call({
                target: address(reverter), value: 0, data: abi.encodeWithSelector(RevertingTarget.fail.selector)
            });
        }
    }

    function _params(ArbExecutor.Call[] memory calls) internal view returns (ArbExecutor.FlashParams memory) {
        return ArbExecutor.FlashParams({
            profitToken: address(token),
            minProfit: 0,
            deadline: block.timestamp + 1 days,
            routeHash: keccak256(abi.encode(calls)),
            calls: calls
        });
    }

    function _callExecute(ArbExecutor executor, uint256 amount, ArbExecutor.FlashParams memory params)
        internal
        returns (bool ok, bytes memory data)
    {
        return address(executor)
            .call(abi.encodeWithSelector(ArbExecutor.executeArb.selector, address(token), amount, params));
    }

    function testExecuteArbRevertsIfFlashLoanCallbackNeverCompletes() public {
        token = new MockToken();
        recorder = new RecorderTarget();
        reverter = new RevertingTarget();
        ArbExecutor executor = _deployExecutor(address(new NoCallbackVault()));
        ArbExecutor.Call[] memory calls = _baseCalls(1);

        (bool ok,) = _callExecute(executor, 100, _params(calls));

        require(!ok, "executeArb must fail closed if flash loan callback does not complete");
        require(recorder.count() == 0, "route calls must not execute without callback");
    }

    function testRouteCallFailureRollsBackEarlierCalls() public {
        token = new MockToken();
        recorder = new RecorderTarget();
        reverter = new RevertingTarget();
        ArbExecutor executor = _deployExecutor(address(new CallbackVault()));
        ArbExecutor.Call[] memory calls = _baseCalls(2);

        (bool ok,) = _callExecute(executor, 100, _params(calls));

        require(!ok, "executeArb must revert when any embedded route call fails");
        require(recorder.count() == 0, "successful earlier route calls must roll back on later failure");
        require(token.balances(address(executor)) == 0, "executor flash-token balance must roll back");
    }

    function testSuccessfulRouteCompletesThroughFlashLoanCallback() public {
        token = new MockToken();
        recorder = new RecorderTarget();
        reverter = new RevertingTarget();
        CallbackVault vault = new CallbackVault();
        ArbExecutor executor = _deployExecutor(address(vault));
        ArbExecutor.Call[] memory calls = _baseCalls(1);

        (bool ok, bytes memory data) = _callExecute(executor, 100, _params(calls));

        require(ok, string(data));
        require(recorder.count() == 1, "successful route call should execute once");
        require(token.balances(address(executor)) == 0, "flash amount should be repaid");
        require(token.balances(address(vault)) == 100, "vault should receive repayment");
    }
}
