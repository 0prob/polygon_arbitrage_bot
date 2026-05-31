// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/**
 * @title ArbExecutor
 * @notice Flash-loan-only arbitrage executor.
 *         All arbitrage is performed using atomic Balancer V2 or Aave V3 flash loans.
 *         There is no support for pre-funded capital, contract balance usage as principal,
 *         or non-flash execution. Both entrypoints (executeArb / executeArbWithAave) require
 *         flashAmount > 0 and will revert with FlashLoanRequired otherwise.
 *         Callbacks enforce that repayment happens inside the flash context (FlashLoanOnly).
 *
 *         The bot TS architecture mirrors this: amountIn from cycle simulation == flash principal.
 */

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IERC20AllowanceMinimal is IERC20Minimal {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20Minimal[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

interface IBalancerVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20Minimal[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IAlgebraFactoryLike {
    function poolByPair(address tokenA, address tokenB) external view returns (address);
}

interface IKyberElasticFactoryLike {
    function getPool(address tokenA, address tokenB, uint24 swapFeeUnits) external view returns (address);
}

interface IAavePool {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IPoolManager {
    function swap(
        PoolKey calldata key,
        bool zeroForOne,
        int128 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata hookData
    ) external returns (int256 delta0, int256 delta1);
    function settle(address currency) external payable;
    function take(address currency, address to, uint256 amount) external;
    function lock(bytes calldata data) external returns (bytes memory result);
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

contract ArbExecutor is IFlashLoanRecipient {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct FlashParams {
        address profitToken;
        uint256 minProfit;
        uint256 deadline;
        bytes32 routeHash;
        Call[] calls;
    }

    struct CallbackData {
        uint8 protocolId;
        address token0;
        address token1;
        uint24 fee;
    }

    uint8 private constant PROTOCOL_UNISWAP_V3 = 1;
    uint8 private constant PROTOCOL_SUSHISWAP_V3 = 2;
    uint8 private constant PROTOCOL_QUICKSWAP_V3 = 3;
    uint8 private constant PROTOCOL_KYBER_ELASTIC = 4;
    uint8 private constant PROTOCOL_UNISWAP_V4 = 5;

    uint8 private constant PHASE_IDLE = 0;
    uint8 private constant PHASE_FLASHLOAN = 1;
    uint8 private constant PHASE_CALLBACK = 2;

    uint256 private constant MAX_CALLS = 12;

    error Unauthorized();
    error DeadlineExpired();
    error EmptyRoute();
    error TooManyCalls();
    error FlashLoanRequired();
    error InvalidRouteHash();
    error FlashLoanOnly();
    error InvalidFlashLoanContext();
    error CallbackOnly();
    error InvalidCallbackSource();
    error UnsupportedProtocol(uint8 protocolId);
    error InvalidPoolCaller(address expected, address actual);
    error ExternalCallFailed(uint256 index, address target, bytes reason);
    error InsufficientProfit(uint256 finalBalance, uint256 requiredBalance);
    error TransferFailed(address token, address to, uint256 amount);
    error ApproveFailed(address token, address spender);
    error ZeroAddress();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PreApproved(address indexed token, address indexed spender);
    event ArbitrageExecuted(
        address indexed executor,
        address indexed profitToken,
        uint256 profitAmount,
        bytes32 indexed routeHash,
        address flashProvider
    );
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);
    event ArbitrageExecutedWithAave(
        address indexed executor,
        address indexed profitToken,
        uint256 profitAmount,
        bytes32 indexed routeHash,
        address flashProvider
    );

    address public owner;

    address public immutable balancerVault;
    address public immutable uniswapV3Factory;
    address public immutable sushiV3Factory;
    address public immutable quickswapV3Factory;
    address public immutable kyberElasticFactory;
    address public immutable aavePool;
    address public immutable poolManager;

    uint8 private _phase;
    bytes32 private _activeRouteHash;
    address private _activeProfitToken;
    uint256 private _activeMinProfit;
    uint256 private _activeInitialProfitBalance;

    uint256 private _locked = 1;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Unauthorized(); // generic error to save bytes
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address owner_,
        address balancerVault_,
        address uniswapV3Factory_,
        address sushiV3Factory_,
        address quickswapV3Factory_,
        address kyberElasticFactory_,
        address aavePool_,
        address poolManager_
    ) {
        if (
            owner_ == address(0) || balancerVault_ == address(0) || uniswapV3Factory_ == address(0)
                || sushiV3Factory_ == address(0) || quickswapV3Factory_ == address(0)
                || kyberElasticFactory_ == address(0) || aavePool_ == address(0) || poolManager_ == address(0)
        ) revert ZeroAddress();

        owner = owner_;
        balancerVault = balancerVault_;
        uniswapV3Factory = uniswapV3Factory_;
        sushiV3Factory = sushiV3Factory_;
        quickswapV3Factory = quickswapV3Factory_;
        kyberElasticFactory = kyberElasticFactory_;
        aavePool = aavePool_;
        poolManager = poolManager_;
        emit OwnershipTransferred(address(0), owner_);
    }

    receive() external payable {}

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function preApprove(address token, address spender) external onlyAuthorized nonReentrant {
        _safeApproveMaxIfNeeded(token, spender, type(uint256).max);
        emit PreApproved(token, spender);
    }

    function approveIfNeeded(address token, address spender, uint256 amount) external nonReentrant {
        if (msg.sender != address(this) && msg.sender != owner) {
            revert Unauthorized();
        }
        _safeApproveMaxIfNeeded(token, spender, amount);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _safeTransfer(token, to, amount);
        emit TokenRescued(token, to, amount);
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(address(0), to, amount);
        emit NativeRescued(to, amount);
    }

    function executeArb(address flashToken, uint256 flashAmount, FlashParams calldata params) external onlyAuthorized {
        if (_phase != PHASE_IDLE) revert InvalidFlashLoanContext();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        uint256 callsLen = params.calls.length;
        if (callsLen == 0) revert EmptyRoute();
        if (callsLen > MAX_CALLS) revert TooManyCalls();
        if (flashAmount == 0) revert FlashLoanRequired();
        if (flashToken == address(0) || params.profitToken == address(0)) revert ZeroAddress();

        bytes32 routeHash = keccak256(abi.encode(params.calls));
        if (routeHash != params.routeHash) revert InvalidRouteHash();

        uint256 initialProfitBalance = IERC20Minimal(params.profitToken).balanceOf(address(this));

        _phase = PHASE_FLASHLOAN;
        _activeRouteHash = routeHash;
        _activeProfitToken = params.profitToken;
        _activeMinProfit = params.minProfit;
        _activeInitialProfitBalance = initialProfitBalance;

        IERC20Minimal[] memory tokens = new IERC20Minimal[](1);
        tokens[0] = IERC20Minimal(flashToken);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = flashAmount;

        IBalancerVault(balancerVault).flashLoan(this, tokens, amounts, abi.encode(params));
        if (_phase != PHASE_IDLE) revert InvalidFlashLoanContext();

        uint256 finalProfitBalance = IERC20Minimal(params.profitToken).balanceOf(address(this));
        uint256 profitAmount;
        unchecked {
            profitAmount = finalProfitBalance >= initialProfitBalance ? finalProfitBalance - initialProfitBalance : 0;
        }

        _clearExecutionContext();

        emit ArbitrageExecuted(msg.sender, params.profitToken, profitAmount, routeHash, balancerVault);
    }

    function receiveFlashLoan(
        IERC20Minimal[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (msg.sender != balancerVault) revert FlashLoanOnly();
        if (_phase != PHASE_FLASHLOAN) revert InvalidFlashLoanContext();

        FlashParams memory params = abi.decode(userData, (FlashParams));
        if (params.routeHash != _activeRouteHash) revert InvalidRouteHash();
        if (params.profitToken != _activeProfitToken) revert InvalidFlashLoanContext();
        if (params.minProfit != _activeMinProfit) revert InvalidFlashLoanContext();
        if (block.timestamp > params.deadline) revert DeadlineExpired();

        _phase = PHASE_CALLBACK;
        _executeCalls(params.calls);

        uint256 len = tokens.length;
        for (uint256 i; i < len;) {
            _safeTransfer(address(tokens[i]), balancerVault, amounts[i] + feeAmounts[i]);
            unchecked {
                ++i;
            }
        }

        _phase = PHASE_IDLE;
        _assertProfit();
    }

    function executeArbWithAave(address flashToken, uint256 flashAmount, FlashParams calldata params)
        external
        onlyAuthorized
    {
        if (_phase != PHASE_IDLE) revert InvalidFlashLoanContext();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        uint256 callsLen = params.calls.length;
        if (callsLen == 0) revert EmptyRoute();
        if (callsLen > MAX_CALLS) revert TooManyCalls();
        if (flashAmount == 0) revert FlashLoanRequired();
        if (flashToken == address(0) || params.profitToken == address(0)) revert ZeroAddress();

        bytes32 routeHash = keccak256(abi.encode(params.calls));
        if (routeHash != params.routeHash) revert InvalidRouteHash();

        uint256 initialProfitBalance = IERC20Minimal(params.profitToken).balanceOf(address(this));

        _phase = PHASE_FLASHLOAN;
        _activeRouteHash = routeHash;
        _activeProfitToken = params.profitToken;
        _activeMinProfit = params.minProfit;
        _activeInitialProfitBalance = initialProfitBalance;

        address[] memory assets = new address[](1);
        assets[0] = flashToken;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = flashAmount;
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        IAavePool(aavePool).flashLoan(address(this), assets, amounts, modes, address(this), abi.encode(params), 0);

        if (_phase != PHASE_IDLE) revert InvalidFlashLoanContext();

        uint256 finalProfitBalance = IERC20Minimal(params.profitToken).balanceOf(address(this));
        uint256 profitAmount;
        unchecked {
            profitAmount = finalProfitBalance >= initialProfitBalance ? finalProfitBalance - initialProfitBalance : 0;
        }

        _clearExecutionContext();

        emit ArbitrageExecutedWithAave(msg.sender, params.profitToken, profitAmount, routeHash, aavePool);
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != aavePool) revert FlashLoanOnly();
        if (_phase != PHASE_FLASHLOAN) revert InvalidFlashLoanContext();
        if (initiator != address(this)) revert Unauthorized();

        FlashParams memory decodedParams = abi.decode(params, (FlashParams));
        if (decodedParams.routeHash != _activeRouteHash) revert InvalidRouteHash();
        if (decodedParams.profitToken != _activeProfitToken) revert InvalidFlashLoanContext();
        if (decodedParams.minProfit != _activeMinProfit) revert InvalidFlashLoanContext();
        if (block.timestamp > decodedParams.deadline) revert DeadlineExpired();

        _phase = PHASE_CALLBACK;
        _executeCalls(decodedParams.calls);

        uint256 totalRepay = amount + premium;
        _safeTransfer(asset, aavePool, totalRepay);

        _phase = PHASE_IDLE;
        _assertProfit();
        return true;
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _handlePoolSwapCallback(PROTOCOL_UNISWAP_V3, amount0Delta, amount1Delta, data);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _handlePoolSwapCallback(PROTOCOL_QUICKSWAP_V3, amount0Delta, amount1Delta, data);
    }

    function swapCallback(int256 deltaQty0, int256 deltaQty1, bytes calldata data) external {
        _handlePoolSwapCallback(PROTOCOL_KYBER_ELASTIC, deltaQty0, deltaQty1, data);
    }

    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager) revert CallbackOnly();
        if (_phase != PHASE_CALLBACK) revert InvalidFlashLoanContext();

        (PoolKey memory key, bool zeroForOne, int128 amountSpecified, uint160 sqrtPriceLimitX96) =
            abi.decode(data, (PoolKey, bool, int128, uint160));

        (int256 delta0, int256 delta1) =
            IPoolManager(poolManager).swap(key, zeroForOne, amountSpecified, sqrtPriceLimitX96, "");

        if (delta0 > 0) IPoolManager(poolManager).settle(key.currency0);
        if (delta1 > 0) IPoolManager(poolManager).settle(key.currency1);
        if (delta0 < 0) IPoolManager(poolManager).take(key.currency0, address(this), uint256(-delta0));
        if (delta1 < 0) IPoolManager(poolManager).take(key.currency1, address(this), uint256(-delta1));

        return "";
    }

    function _handlePoolSwapCallback(uint8 protocolId, int256 amount0Delta, int256 amount1Delta, bytes calldata data)
        internal
    {
        if (_phase != PHASE_CALLBACK) revert CallbackOnly();

        CallbackData memory callbackData = abi.decode(data, (CallbackData));
        // Accept both native Uniswap V3 and SushiSwap V3 — both fork the
        // same V3 callback interface and differ only by pool factory address.
        if (protocolId == PROTOCOL_UNISWAP_V3) {
            if (callbackData.protocolId != PROTOCOL_UNISWAP_V3 && callbackData.protocolId != PROTOCOL_SUSHISWAP_V3) {
                revert UnsupportedProtocol(callbackData.protocolId);
            }
        } else if (callbackData.protocolId != protocolId) {
            revert UnsupportedProtocol(callbackData.protocolId);
        }

        address expectedPool = _resolveExpectedPool(callbackData);
        if (expectedPool == address(0)) revert InvalidCallbackSource();
        if (msg.sender != expectedPool) revert InvalidPoolCaller(expectedPool, msg.sender);

        if (amount0Delta > 0) {
            _safeTransfer(callbackData.token0, msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            _safeTransfer(callbackData.token1, msg.sender, uint256(amount1Delta));
        }
    }

    function _resolveExpectedPool(CallbackData memory callbackData) internal view returns (address) {
        if (callbackData.protocolId == PROTOCOL_UNISWAP_V3) {
            return
                IUniswapV3FactoryLike(uniswapV3Factory)
                    .getPool(callbackData.token0, callbackData.token1, callbackData.fee);
        }
        if (callbackData.protocolId == PROTOCOL_SUSHISWAP_V3) {
            return
                IUniswapV3FactoryLike(sushiV3Factory)
                    .getPool(callbackData.token0, callbackData.token1, callbackData.fee);
        }
        if (callbackData.protocolId == PROTOCOL_QUICKSWAP_V3) {
            return IAlgebraFactoryLike(quickswapV3Factory).poolByPair(callbackData.token0, callbackData.token1);
        }
        if (callbackData.protocolId == PROTOCOL_KYBER_ELASTIC) {
            return IKyberElasticFactoryLike(kyberElasticFactory)
                .getPool(callbackData.token0, callbackData.token1, callbackData.fee);
        }
        revert UnsupportedProtocol(callbackData.protocolId);
    }

    function _executeCalls(Call[] memory calls) internal {
        uint256 len = calls.length;
        for (uint256 i; i < len;) {
            Call memory call_ = calls[i];
            (bool ok, bytes memory result) = call_.target.call{value: call_.value}(call_.data);
            if (!ok) revert ExternalCallFailed(i, call_.target, result);
            unchecked {
                ++i;
            }
        }
    }

    function _assertProfit() internal view {
        uint256 finalBalance = IERC20Minimal(_activeProfitToken).balanceOf(address(this));
        uint256 requiredBalance = _activeInitialProfitBalance + _activeMinProfit;
        if (finalBalance < requiredBalance) {
            revert InsufficientProfit(finalBalance, requiredBalance);
        }
    }

    function _clearExecutionContext() internal {
        _phase = PHASE_IDLE;
        _activeRouteHash = bytes32(0);
        _activeProfitToken = address(0);
        _activeMinProfit = 0;
        _activeInitialProfitBalance = 0;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TransferFailed(token, to, amount);
        }
    }

    function _safeAllowance(address token, address owner_, address spender) internal view returns (uint256) {
        (bool ok, bytes memory result) =
            token.staticcall(abi.encodeWithSelector(IERC20AllowanceMinimal.allowance.selector, owner_, spender));
        if (!ok || result.length < 32) revert ApproveFailed(token, spender);
        return abi.decode(result, (uint256));
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory result) =
            token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert ApproveFailed(token, spender);
        }
    }

    function _safeApproveMaxIfNeeded(address token, address spender, uint256 amount) internal {
        uint256 current = _safeAllowance(token, address(this), spender);
        if (current >= amount) return;

        if (current != 0) {
            _safeApprove(token, spender, 0);
        }
        _safeApprove(token, spender, type(uint256).max);
    }
}
