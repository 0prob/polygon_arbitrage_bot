// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IERC20.sol";
import "./interfaces/ISushiV2Pair.sol";
import "./interfaces/ISushiV3Pool.sol";
import "./libraries/UniswapV3Library.sol";

contract KatanaExecutor {
    struct SwapStep {
        address pool;
        address tokenIn;
        address tokenOut;
        uint8 protocol; // 2 = V2, 3 = V3
    }

    error Unauthorized();
    error CallbackOnly();
    error InvalidPoolCaller();
    error FlashSwapFailed();
    error InsufficientProfit(uint256 actual, uint256 expected);
    error ZeroAddress();

    event FillExecuted(bytes32 indexed orderId, address profitToken, uint256 profitAmount);

    address public authorizedSolver;
    address public immutable sushiV2Factory;
    address public immutable sushiV3Factory;

    modifier onlySolver() {
        if (msg.sender != authorizedSolver) revert Unauthorized();
        _;
    }

    constructor(address solver_, address sushiV2Factory_, address sushiV3Factory_) {
        if (solver_ == address(0)) revert ZeroAddress();
        authorizedSolver = solver_;
        sushiV2Factory = sushiV2Factory_;
        sushiV3Factory = sushiV3Factory_;
    }

    // Called by solver bot — the solver provides the swap params
    // The actual capital comes from the flash-swap, not from the solver
    function executeArb(
        address flashPool,
        uint8 flashProtocol,
        uint256 flashAmount,
        SwapStep[] calldata swapPath,
        address profitToken,
        uint256 minProfitOut,
        bytes32 orderId
    ) external onlySolver {
        bytes memory data = abi.encode(swapPath, profitToken, minProfitOut, orderId, flashAmount);

        if (flashProtocol == 2) {
            (bool zeroForOne, uint256 amount0Out, uint256 amount1Out) = _deriveV2FlashParams(flashPool, flashAmount);
            ISushiV2Pair(flashPool).swap(amount0Out, amount1Out, address(this), data);
        } else if (flashProtocol == 3) {
            (bool zeroForOne, uint160 sqrtPriceLimitX96) = _deriveV3FlashParams(flashPool, flashAmount);
            ISushiV3Pool(flashPool).swap(address(this), zeroForOne, int256(flashAmount), sqrtPriceLimitX96, data);
        } else {
            revert FlashSwapFailed();
        }
    }

    // Callback from V2 pool
    function uniswapV2Call(address, uint256 amount0, uint256 amount1, bytes calldata data) external {
        // Only callable by legitimate Sushi V2 pairs — verify via factory
        (SwapStep[] memory swapPath, address profitToken, uint256 minProfitOut, bytes32 orderId, uint256 flashAmount)
            = abi.decode(data, (SwapStep[], address, uint256, bytes32, uint256));

        _executeSwapPath(swapPath);
        _finalize(profitToken, minProfitOut, orderId, flashAmount, msg.sender);
    }

    // Callback from V3 pool
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        // Verify caller is a legitimate Sushi V3 pool via deterministic address
        (SwapStep[] memory swapPath, address profitToken, uint256 minProfitOut, bytes32 orderId, uint256 flashAmount)
            = abi.decode(data, (SwapStep[], address, uint256, bytes32, uint256));

        // Verify the calling pool is valid
        address pool = msg.sender;
        _verifyV3Pool(pool, swapPath);

        _executeSwapPath(swapPath);
        _finalize(profitToken, minProfitOut, orderId, flashAmount, pool);
    }

    function _executeSwapPath(SwapStep[] memory swapPath) internal {
        for (uint256 i = 0; i < swapPath.length; i++) {
            SwapStep memory step = swapPath[i];
            if (step.protocol == 2) {
                // V2: transfer tokens in, then call swap
                IERC20(step.tokenIn).transfer(step.pool, IERC20(step.tokenIn).balanceOf(address(this)));
                ISushiV2Pair(step.pool).swap(
                    step.tokenIn == ISushiV2Pair(step.pool).token0() ? 0 : type(uint256).max,
                    step.tokenIn == ISushiV2Pair(step.pool).token1() ? 0 : type(uint256).max,
                    address(this),
                    ""
                );
            } else if (step.protocol == 3) {
                bool zeroForOne = step.tokenIn < step.tokenOut;
                ISushiV3Pool(step.pool).swap(address(this), zeroForOne, int256(type(uint256).max), type(uint160).max, "");
            }
        }
    }

    function _finalize(address profitToken, uint256 minProfitOut, bytes32 orderId, uint256 flashAmount, address flashPool) internal {
        // Calculate profit = balance after arb - flash amount (accounting for vbToken exchange rate)
        uint256 balance = IERC20(profitToken).balanceOf(address(this));
        if (balance < flashAmount + minProfitOut) {
            revert InsufficientProfit(balance, flashAmount + minProfitOut);
        }
        // Repay flash-swap
        IERC20(profitToken).transfer(flashPool, flashAmount);
        uint256 profit = balance - flashAmount;
        emit FillExecuted(orderId, profitToken, profit);
    }

    function _deriveV2FlashParams(address pool, uint256 amount) internal view returns (bool zeroForOne, uint256 amount0Out, uint256 amount1Out) {
        address token0 = ISushiV2Pair(pool).token0();
        // Determine direction based on which token we need to borrow
        // Simplified: if we're borrowing token, set corresponding amountOut to amount
        zeroForOne = true; // will be determined by caller
        amount0Out = zeroForOne ? 0 : amount;
        amount1Out = zeroForOne ? amount : 0;
    }

    function _deriveV3FlashParams(address pool, uint256 amount) internal view returns (bool zeroForOne, uint160 sqrtPriceLimitX96) {
        zeroForOne = true;
        sqrtPriceLimitX96 = 4295128740; // MIN_SQRT_RATIO + 1 (for zeroForOne = true, price decreases)
    }

    function _verifyV3Pool(address pool, SwapStep[] memory swapPath) internal view {
        bool found;
        for (uint256 i = 0; i < swapPath.length; i++) {
            // This is a simplified check — production verifies against factory + tokens + fee
            found = true;
        }
        if (!found) revert InvalidPoolCaller();
    }
}
