// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/**
 * @title ArbExecutor
 * @notice Flash-loan-only arbitrage executor rewritten in gas-optimized EVM assembly.
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
        
        assembly {
            // emit OwnershipTransferred(address(0), owner_)
            log3(0, 0, 0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0, 0, owner_)
        }
    }

    receive() external payable {}

    function transferOwnership(address newOwner) external {
        assembly {
            // onlyOwner check
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if iszero(eq(caller(), currentOwner)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // ZeroAddress check
            if iszero(newOwner) {
                mstore(0, 0xd92e233d00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // Update owner
            let slotVal := sload(owner.slot)
            let mask := not(shl(mul(owner.offset, 8), 0xffffffffffffffffffffffffffffffffffffffff))
            let newSlotVal := or(and(slotVal, mask), shl(mul(owner.offset, 8), and(newOwner, 0xffffffffffffffffffffffffffffffffffffffff)))
            sstore(owner.slot, newSlotVal)
            
            // emit OwnershipTransferred(previousOwner, newOwner)
            log3(0, 0, 0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0, currentOwner, newOwner)
        }
    }

    function preApprove(address token, address spender) external {
        assembly {
            // onlyAuthorized (msg.sender == owner)
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if iszero(eq(caller(), currentOwner)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // nonReentrant (check _locked)
            let lockVal := sload(_locked.slot)
            if iszero(eq(lockVal, 1)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            sstore(_locked.slot, 2)
        }
        
        _safeApproveMaxIfNeeded(token, spender, type(uint256).max);
        
        assembly {
            // emit PreApproved(token, spender)
            log3(0, 0, 0x8d936a3b74312b60e024ee1b476014e8bd0523e8355d93ff5a0787567fe92f5f, token, spender)
            
            // Unlock
            sstore(_locked.slot, 1)
        }
    }

    function approveIfNeeded(address token, address spender, uint256 amount) external {
        assembly {
            // authorized: msg.sender == address(this) || msg.sender == owner
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if and(iszero(eq(caller(), address())), iszero(eq(caller(), currentOwner))) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // nonReentrant (check _locked)
            let lockVal := sload(_locked.slot)
            if iszero(eq(lockVal, 1)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            sstore(_locked.slot, 2)
        }
        
        _safeApproveMaxIfNeeded(token, spender, amount);
        
        assembly {
            // Unlock
            sstore(_locked.slot, 1)
        }
    }

    function transferAll(address token, address to) external {
        assembly {
            // authorized: msg.sender == address(this) || msg.sender == owner
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if and(iszero(eq(caller(), address())), iszero(eq(caller(), currentOwner))) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // nonReentrant (check _locked)
            let lockVal := sload(_locked.slot)
            if iszero(eq(lockVal, 1)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            sstore(_locked.slot, 2)
            
            // balance = balanceOf(address(this))
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            let success := staticcall(gas(), token, 0, 36, 0, 32)
            if or(iszero(success), lt(returndatasize(), 32)) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, token)
                mstore(36, to)
                mstore(68, 0)
                revert(0, 100)
            }
            let bal := mload(0)
            
            if gt(bal, 0) {
                // transfer(to, bal)
                mstore(0, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
                mstore(4, and(to, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, bal)
                let success2 := call(gas(), token, 0, 0, 68, 0, 32)
                let valid2 := 0
                switch success2
                case 1 {
                    switch returndatasize()
                    case 0 { valid2 := 1 }
                    case 32 { if mload(0) { valid2 := 1 } }
                }
                if iszero(valid2) {
                    mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                    mstore(4, token)
                    mstore(36, to)
                    mstore(68, bal)
                    revert(0, 100)
                }
            }
            
            // Unlock
            sstore(_locked.slot, 1)
        }
    }

    function rescueToken(address token, address to, uint256 amount) external {
        assembly {
            // onlyOwner check
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if iszero(eq(caller(), currentOwner)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // ZeroAddress check
            if iszero(to) {
                mstore(0, 0xd92e233d00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // nonReentrant (check _locked)
            let lockVal := sload(_locked.slot)
            if iszero(eq(lockVal, 1)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            sstore(_locked.slot, 2)
            
            // transfer(to, amount)
            mstore(0, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(4, and(to, 0xffffffffffffffffffffffffffffffffffffffff))
            mstore(36, amount)
            let success2 := call(gas(), token, 0, 0, 68, 0, 32)
            let valid2 := 0
            switch success2
            case 1 {
                switch returndatasize()
                case 0 { valid2 := 1 }
                case 32 { if mload(0) { valid2 := 1 } }
            }
            if iszero(valid2) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, token)
                mstore(36, to)
                mstore(68, amount)
                revert(0, 100)
            }
            
            // emit TokenRescued(token, to, amount)
            mstore(0, amount)
            log3(0, 32, 0x4143f7b5cb6ea007914c32b8a3e64cebc051d7f493fa0755454da1e47701e125, token, to)
            
            // Unlock
            sstore(_locked.slot, 1)
        }
    }

    function rescueNative(address payable to, uint256 amount) external {
        assembly {
            // onlyOwner check
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if iszero(eq(caller(), currentOwner)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // ZeroAddress check
            if iszero(to) {
                mstore(0, 0xd92e233d00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // nonReentrant (check _locked)
            let lockVal := sload(_locked.slot)
            if iszero(eq(lockVal, 1)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            sstore(_locked.slot, 2)
            
            let ok := call(gas(), to, amount, 0, 0, 0, 0)
            if iszero(ok) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, 0)
                mstore(36, to)
                mstore(68, amount)
                revert(0, 100)
            }
            
            // emit NativeRescued(to, amount)
            mstore(0, amount)
            log2(0, 32, 0xe3eb98b7fe2a0c1d490b92af73eeae611e9b00ab3c3f70b20bd7bb43f67a0f43, to)
            
            // Unlock
            sstore(_locked.slot, 1)
        }
    }

    function executeArb(address flashToken, uint256 flashAmount, FlashParams calldata params) external {
        address vault = balancerVault;
        uint256 deadline = params.deadline;
        uint256 minProfit = params.minProfit;
        address profitToken = params.profitToken;
        bytes32 routeHashFromParams = params.routeHash;
        bytes32 routeHash = keccak256(abi.encode(params.calls));
        uint256 callsLen = params.calls.length;
        uint256 initialProfitBalance;

        assembly {
            // onlyAuthorized
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if iszero(eq(caller(), currentOwner)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // _phase != PHASE_IDLE
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 0)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // block.timestamp > deadline
            if gt(timestamp(), deadline) {
                mstore(0, 0x1ab7da6b00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // routeHash check
            if iszero(eq(routeHash, routeHashFromParams)) {
                mstore(0, 0xc858adff00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // callsLen check
            if iszero(callsLen) {
                mstore(0, 0xea60ab1d00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            if gt(callsLen, 12) {
                mstore(0, 0xf5dedbff00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            if iszero(flashAmount) {
                mstore(0, 0x946302fe00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            if or(iszero(flashToken), iszero(profitToken)) {
                mstore(0, 0xd92e233d00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }

            // initial profit balance
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            let success := staticcall(gas(), profitToken, 0, 36, 0, 32)
            if or(iszero(success), lt(returndatasize(), 32)) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, profitToken)
                mstore(36, address())
                mstore(68, 0)
                revert(0, 100)
            }
            initialProfitBalance := mload(0)
            
            // Set state
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := or(and(slotVal, mask), shl(mul(_phase.offset, 8), 1))
            sstore(_phase.slot, newSlotVal)
            
            sstore(_activeRouteHash.slot, routeHash)
            sstore(_activeProfitToken.slot, profitToken)
            sstore(_activeMinProfit.slot, minProfit)
            sstore(_activeInitialProfitBalance.slot, initialProfitBalance)
        }

        IERC20Minimal[] memory tokens = new IERC20Minimal[](1);
        tokens[0] = IERC20Minimal(flashToken);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = flashAmount;

        IBalancerVault(vault).flashLoan(this, tokens, amounts, abi.encode(params));

        uint256 profitAmount;
        assembly {
            // check _phase == PHASE_IDLE
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 0)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // final balance
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            let success := staticcall(gas(), profitToken, 0, 36, 0, 32)
            if or(iszero(success), lt(returndatasize(), 32)) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, profitToken)
                mstore(36, address())
                mstore(68, 0)
                revert(0, 100)
            }
            let finalProfitBalance := mload(0)
            
            if iszero(lt(finalProfitBalance, initialProfitBalance)) {
                profitAmount := sub(finalProfitBalance, initialProfitBalance)
            }
            
            // clear context
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := and(slotVal, mask)
            sstore(_phase.slot, newSlotVal)
            
            sstore(_activeRouteHash.slot, 0)
            sstore(_activeProfitToken.slot, 0)
            sstore(_activeMinProfit.slot, 0)
            sstore(_activeInitialProfitBalance.slot, 0)
            
            // emit ArbitrageExecuted(msg.sender, params.profitToken, profitAmount, routeHash, balancerVault)
            mstore(0, profitAmount)
            mstore(32, vault)
            log4(0, 64, 0x2790eac69d46d24bb29b55a23b12e2e49076dc2a9fdcb340e641de33fca2c5dd, caller(), profitToken, routeHash)
        }
    }

    function receiveFlashLoan(
        IERC20Minimal[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        address vault = balancerVault;
        if (msg.sender != vault) revert FlashLoanOnly();
        
        assembly {
            // _phase != PHASE_FLASHLOAN (1)
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 1)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
        }

        FlashParams memory params = abi.decode(userData, (FlashParams));
        
        uint256 deadline = params.deadline;
        address profitToken = params.profitToken;
        uint256 minProfit = params.minProfit;
        bytes32 routeHash = params.routeHash;
        
        assembly {
            let activeRouteHash := sload(_activeRouteHash.slot)
            if iszero(eq(routeHash, activeRouteHash)) {
                mstore(0, 0xc858adff00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            let activeProfitToken := sload(_activeProfitToken.slot)
            if iszero(eq(profitToken, activeProfitToken)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            let activeMinProfit := sload(_activeMinProfit.slot)
            if iszero(eq(minProfit, activeMinProfit)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            if gt(timestamp(), deadline) {
                mstore(0, 0x1ab7da6b00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // set _phase = PHASE_CALLBACK (2)
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := or(and(slotVal, mask), shl(mul(_phase.offset, 8), 2))
            sstore(_phase.slot, newSlotVal)
        }
        
        _executeCalls(params.calls);
        
        uint256 len = tokens.length;
        for (uint256 i; i < len;) {
            _safeTransfer(address(tokens[i]), vault, amounts[i] + feeAmounts[i]);
            unchecked {
                ++i;
            }
        }
        
        assembly {
            // set _phase = PHASE_IDLE (0)
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := and(slotVal, mask)
            sstore(_phase.slot, newSlotVal)
        }
        
        _assertProfit();
    }

    function executeArbWithAave(address flashToken, uint256 flashAmount, FlashParams calldata params)
        external
    {
        address pool = aavePool;
        uint256 deadline = params.deadline;
        uint256 minProfit = params.minProfit;
        address profitToken = params.profitToken;
        bytes32 routeHashFromParams = params.routeHash;
        bytes32 routeHash = keccak256(abi.encode(params.calls));
        uint256 callsLen = params.calls.length;
        uint256 initialProfitBalance;

        assembly {
            // onlyAuthorized
            let currentOwner := and(shr(mul(owner.offset, 8), sload(owner.slot)), 0xffffffffffffffffffffffffffffffffffffffff)
            if iszero(eq(caller(), currentOwner)) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // _phase != PHASE_IDLE
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 0)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // block.timestamp > deadline
            if gt(timestamp(), deadline) {
                mstore(0, 0x1ab7da6b00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // routeHash check
            if iszero(eq(routeHash, routeHashFromParams)) {
                mstore(0, 0xc858adff00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // callsLen check
            if iszero(callsLen) {
                mstore(0, 0xea60ab1d00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            if gt(callsLen, 12) {
                mstore(0, 0xf5dedbff00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            if iszero(flashAmount) {
                mstore(0, 0x946302fe00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            if or(iszero(flashToken), iszero(profitToken)) {
                mstore(0, 0xd92e233d00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }

            // initial profit balance
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            let success := staticcall(gas(), profitToken, 0, 36, 0, 32)
            if or(iszero(success), lt(returndatasize(), 32)) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, profitToken)
                mstore(36, address())
                mstore(68, 0)
                revert(0, 100)
            }
            initialProfitBalance := mload(0)
            
            // Set state
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := or(and(slotVal, mask), shl(mul(_phase.offset, 8), 1))
            sstore(_phase.slot, newSlotVal)
            
            sstore(_activeRouteHash.slot, routeHash)
            sstore(_activeProfitToken.slot, profitToken)
            sstore(_activeMinProfit.slot, minProfit)
            sstore(_activeInitialProfitBalance.slot, initialProfitBalance)
        }

        address[] memory assets = new address[](1);
        assets[0] = flashToken;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = flashAmount;
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        IAavePool(pool).flashLoan(address(this), assets, amounts, modes, address(this), abi.encode(params), 0);

        uint256 profitAmount;
        assembly {
            // check _phase == PHASE_IDLE
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 0)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // final balance
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            let success := staticcall(gas(), profitToken, 0, 36, 0, 32)
            if or(iszero(success), lt(returndatasize(), 32)) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, profitToken)
                mstore(36, address())
                mstore(68, 0)
                revert(0, 100)
            }
            let finalProfitBalance := mload(0)
            
            if iszero(lt(finalProfitBalance, initialProfitBalance)) {
                profitAmount := sub(finalProfitBalance, initialProfitBalance)
            }
            
            // clear context
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := and(slotVal, mask)
            sstore(_phase.slot, newSlotVal)
            
            sstore(_activeRouteHash.slot, 0)
            sstore(_activeProfitToken.slot, 0)
            sstore(_activeMinProfit.slot, 0)
            sstore(_activeInitialProfitBalance.slot, 0)
            
            // emit ArbitrageExecutedWithAave(msg.sender, params.profitToken, profitAmount, routeHash, aavePool)
            mstore(0, profitAmount)
            mstore(32, pool)
            log4(0, 64, 0xcf310e875090b29d50540b311226f96c6d78f2cdd5265f1481c9772c59620f4e, caller(), profitToken, routeHash)
        }
    }

    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != aavePool) revert FlashLoanOnly();
        
        assembly {
            // _phase != PHASE_FLASHLOAN (1)
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 1)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            // initiator != address(this)
            if iszero(eq(initiator, address())) {
                mstore(0, 0x82b4290000000000000000000000000000000000000000000000000000000000) // Unauthorized
                revert(0, 4)
            }
        }

        FlashParams memory decodedParams = abi.decode(params, (FlashParams));
        
        uint256 deadline = decodedParams.deadline;
        address profitToken = decodedParams.profitToken;
        uint256 minProfit = decodedParams.minProfit;
        bytes32 routeHash = decodedParams.routeHash;
        
        assembly {
            let activeRouteHash := sload(_activeRouteHash.slot)
            if iszero(eq(routeHash, activeRouteHash)) {
                mstore(0, 0xc858adff00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            let activeProfitToken := sload(_activeProfitToken.slot)
            if iszero(eq(profitToken, activeProfitToken)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            let activeMinProfit := sload(_activeMinProfit.slot)
            if iszero(eq(minProfit, activeMinProfit)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            if gt(timestamp(), deadline) {
                mstore(0, 0x1ab7da6b00000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            
            // set _phase = PHASE_CALLBACK (2)
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := or(and(slotVal, mask), shl(mul(_phase.offset, 8), 2))
            sstore(_phase.slot, newSlotVal)
        }
        
        _executeCalls(decodedParams.calls);
        
        uint256 totalRepay = amount + premium;
        _safeTransfer(asset, aavePool, totalRepay);
        
        assembly {
            // set _phase = PHASE_IDLE (0)
            let slotVal := sload(_phase.slot)
            let mask := not(shl(mul(_phase.offset, 8), 0xff))
            let newSlotVal := and(slotVal, mask)
            sstore(_phase.slot, newSlotVal)
        }
        
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
        address manager = poolManager;
        if (msg.sender != manager) revert CallbackOnly();
        
        assembly {
            // _phase != PHASE_CALLBACK (2)
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 2)) {
                mstore(0, 0xadd4adc000000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
        }

        (PoolKey memory key, bool zeroForOne, int128 amountSpecified, uint160 sqrtPriceLimitX96) =
            abi.decode(data, (PoolKey, bool, int128, uint160));

        (int256 delta0, int256 delta1) =
            IPoolManager(manager).swap(key, zeroForOne, amountSpecified, sqrtPriceLimitX96, "");

        assembly {
            // if (delta0 > 0)
            if sgt(delta0, 0) {
                let currency0 := mload(key)
                mstore(0, 0x6a256b2900000000000000000000000000000000000000000000000000000000)
                mstore(4, and(currency0, 0xffffffffffffffffffffffffffffffffffffffff))
                let success := call(gas(), manager, 0, 0, 36, 0, 0)
                if iszero(success) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }
            // if (delta1 > 0)
            if sgt(delta1, 0) {
                let currency1 := mload(add(key, 32))
                mstore(0, 0x6a256b2900000000000000000000000000000000000000000000000000000000)
                mstore(4, and(currency1, 0xffffffffffffffffffffffffffffffffffffffff))
                let success := call(gas(), manager, 0, 0, 36, 0, 0)
                if iszero(success) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }
            // if (delta0 < 0)
            if slt(delta0, 0) {
                let currency0 := mload(key)
                let val := sub(0, delta0)
                mstore(0, 0x0b0d9c0900000000000000000000000000000000000000000000000000000000)
                mstore(4, and(currency0, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, address())
                mstore(68, val)
                let success := call(gas(), manager, 0, 0, 100, 0, 0)
                if iszero(success) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }
            // if (delta1 < 0)
            if slt(delta1, 0) {
                let currency1 := mload(add(key, 32))
                let val := sub(0, delta1)
                mstore(0, 0x0b0d9c0900000000000000000000000000000000000000000000000000000000)
                mstore(4, and(currency1, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, address())
                mstore(68, val)
                let success := call(gas(), manager, 0, 0, 100, 0, 0)
                if iszero(success) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }
        }

        return "";
    }

    function _handlePoolSwapCallback(uint8 protocolId, int256 amount0Delta, int256 amount1Delta, bytes calldata data)
        internal
    {
        assembly {
            // if (_phase != PHASE_CALLBACK) revert CallbackOnly();
            let phaseVal := and(shr(mul(_phase.offset, 8), sload(_phase.slot)), 0xff)
            if iszero(eq(phaseVal, 2)) {
                mstore(0, 0xc21d53e800000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
        }

        CallbackData memory callbackData = abi.decode(data, (CallbackData));
        
        uint8 cbProtocolId = callbackData.protocolId;
        address token0 = callbackData.token0;
        address token1 = callbackData.token1;
        
        assembly {
            let validProtocol := 0
            switch protocolId
            case 1 { // PROTOCOL_UNISWAP_V3
                if or(eq(cbProtocolId, 1), eq(cbProtocolId, 2)) {
                    validProtocol := 1
                }
            }
            default {
                if eq(cbProtocolId, protocolId) {
                    validProtocol := 1
                }
            }
            
            if iszero(validProtocol) {
                mstore(0, 0xf850442b00000000000000000000000000000000000000000000000000000000)
                mstore(4, cbProtocolId)
                revert(0, 36)
            }
        }
        
        address expectedPool = _resolveExpectedPool(callbackData);
        
        assembly {
            if iszero(expectedPool) {
                mstore(0, 0x936198e900000000000000000000000000000000000000000000000000000000)
                revert(0, 4)
            }
            if iszero(eq(caller(), expectedPool)) {
                mstore(0, 0xf206255900000000000000000000000000000000000000000000000000000000)
                mstore(4, expectedPool)
                mstore(36, caller())
                revert(0, 68)
            }
            
            if sgt(amount0Delta, 0) {
                mstore(0, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
                mstore(4, expectedPool)
                mstore(36, amount0Delta)
                let success2 := call(gas(), token0, 0, 0, 68, 0, 32)
                let valid2 := 0
                switch success2
                case 1 {
                    switch returndatasize()
                    case 0 { valid2 := 1 }
                    case 32 { if mload(0) { valid2 := 1 } }
                }
                if iszero(valid2) {
                    mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                    mstore(4, token0)
                    mstore(36, expectedPool)
                    mstore(68, amount0Delta)
                    revert(0, 100)
                }
            }
            
            if sgt(amount1Delta, 0) {
                mstore(0, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
                mstore(4, expectedPool)
                mstore(36, amount1Delta)
                let success2 := call(gas(), token1, 0, 0, 68, 0, 32)
                let valid2 := 0
                switch success2
                case 1 {
                    switch returndatasize()
                    case 0 { valid2 := 1 }
                    case 32 { if mload(0) { valid2 := 1 } }
                }
                if iszero(valid2) {
                    mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                    mstore(4, token1)
                    mstore(36, expectedPool)
                    mstore(68, amount1Delta)
                    revert(0, 100)
                }
            }
        }
    }

    function _resolveExpectedPool(CallbackData memory callbackData) internal view returns (address pool) {
        uint8 protocolId = callbackData.protocolId;
        address token0 = callbackData.token0;
        address token1 = callbackData.token1;
        uint24 fee = callbackData.fee;
        
        address v3Factory = uniswapV3Factory;
        address sV3Factory = sushiV3Factory;
        address qV3Factory = quickswapV3Factory;
        address keFactory = kyberElasticFactory;
        
        assembly {
            let success := 0
            switch protocolId
            case 1 { // PROTOCOL_UNISWAP_V3
                mstore(0, 0x1698ee8200000000000000000000000000000000000000000000000000000000)
                mstore(4, and(token0, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, and(token1, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(68, fee)
                success := staticcall(gas(), v3Factory, 0, 100, 0, 32)
                if and(success, iszero(lt(returndatasize(), 32))) {
                    pool := mload(0)
                }
            }
            case 2 { // PROTOCOL_SUSHISWAP_V3
                mstore(0, 0x1698ee8200000000000000000000000000000000000000000000000000000000)
                mstore(4, and(token0, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, and(token1, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(68, fee)
                success := staticcall(gas(), sV3Factory, 0, 100, 0, 32)
                if and(success, iszero(lt(returndatasize(), 32))) {
                    pool := mload(0)
                }
            }
            case 3 { // PROTOCOL_QUICKSWAP_V3
                mstore(0, 0xd9a641e100000000000000000000000000000000000000000000000000000000)
                mstore(4, and(token0, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, and(token1, 0xffffffffffffffffffffffffffffffffffffffff))
                success := staticcall(gas(), qV3Factory, 0, 68, 0, 32)
                if and(success, iszero(lt(returndatasize(), 32))) {
                    pool := mload(0)
                }
            }
            case 4 { // PROTOCOL_KYBER_ELASTIC
                mstore(0, 0x1698ee8200000000000000000000000000000000000000000000000000000000)
                mstore(4, and(token0, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, and(token1, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(68, fee)
                success := staticcall(gas(), keFactory, 0, 100, 0, 32)
                if and(success, iszero(lt(returndatasize(), 32))) {
                    pool := mload(0)
                }
            }
            default {
                mstore(0, 0xf850442b00000000000000000000000000000000000000000000000000000000)
                mstore(4, protocolId)
                revert(0, 36)
            }
        }
    }

    function _executeCalls(Call[] memory calls) internal {
        assembly {
            let len := mload(calls)
            for { let i := 0 } lt(i, len) { i := add(i, 1) } {
                let callPtr := mload(add(calls, add(32, mul(i, 32))))
                let target := mload(callPtr)
                let value := mload(add(callPtr, 32))
                let dataPtr := mload(add(callPtr, 64))
                let dataLen := mload(dataPtr)
                let dataStart := add(dataPtr, 32)
                
                let ok := call(gas(), target, value, dataStart, dataLen, 0, 0)
                if iszero(ok) {
                    let freeMem := mload(0x40)
                    mstore(freeMem, 0x0f43457300000000000000000000000000000000000000000000000000000000)
                    mstore(add(freeMem, 4), i)
                    mstore(add(freeMem, 36), and(target, 0xffffffffffffffffffffffffffffffffffffffff))
                    mstore(add(freeMem, 68), 96)
                    
                    let retSz := returndatasize()
                    mstore(add(freeMem, 100), retSz)
                    returndatacopy(add(freeMem, 132), 0, retSz)
                    
                    let totalRevertSize := add(132, retSz)
                    revert(freeMem, totalRevertSize)
                }
            }
        }
    }

    function _assertProfit() internal view {
        address profitToken = _activeProfitToken;
        uint256 minProfit = _activeMinProfit;
        uint256 initialBalance = _activeInitialProfitBalance;
        
        assembly {
            mstore(0, 0x70a0823100000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            let success := staticcall(gas(), profitToken, 0, 36, 0, 32)
            if or(iszero(success), lt(returndatasize(), 32)) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, profitToken)
                mstore(36, address())
                mstore(68, 0)
                revert(0, 100)
            }
            let finalBalance := mload(0)
            
            let requiredBalance := add(initialBalance, minProfit)
            if lt(finalBalance, requiredBalance) {
                mstore(0, 0x4e88422a00000000000000000000000000000000000000000000000000000000)
                mstore(4, finalBalance)
                mstore(36, requiredBalance)
                revert(0, 68)
            }
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        assembly {
            mstore(0, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(4, and(to, 0xffffffffffffffffffffffffffffffffffffffff))
            mstore(36, amount)
            let success := call(gas(), token, 0, 0, 68, 0, 32)
            let valid := 0
            switch success
            case 1 {
                switch returndatasize()
                case 0 { valid := 1 }
                case 32 { if mload(0) { valid := 1 } }
            }
            if iszero(valid) {
                mstore(0, 0xbf182be800000000000000000000000000000000000000000000000000000000)
                mstore(4, token)
                mstore(36, to)
                mstore(68, amount)
                revert(0, 100)
            }
        }
    }

    function _safeApproveMaxIfNeeded(address token, address spender, uint256 amount) internal {
        assembly {
            mstore(0, 0xdd62ed3e00000000000000000000000000000000000000000000000000000000)
            mstore(4, address())
            mstore(36, and(spender, 0xffffffffffffffffffffffffffffffffffffffff))
            let success := staticcall(gas(), token, 0, 68, 0, 32)
            if or(iszero(success), lt(returndatasize(), 32)) {
                mstore(0, 0x1b6c83ab00000000000000000000000000000000000000000000000000000000)
                mstore(4, token)
                mstore(36, spender)
                revert(0, 68)
            }
            let current := mload(0)
            
            if lt(current, amount) {
                if iszero(iszero(current)) {
                    mstore(0, 0x095ea7b300000000000000000000000000000000000000000000000000000000)
                    mstore(4, and(spender, 0xffffffffffffffffffffffffffffffffffffffff))
                    mstore(36, 0)
                    let success2 := call(gas(), token, 0, 0, 68, 0, 32)
                    let valid2 := 0
                    switch success2
                    case 1 {
                        switch returndatasize()
                        case 0 { valid2 := 1 }
                        case 32 { if mload(0) { valid2 := 1 } }
                    }
                    if iszero(valid2) {
                        mstore(0, 0x1b6c83ab00000000000000000000000000000000000000000000000000000000)
                        mstore(4, token)
                        mstore(36, spender)
                        revert(0, 68)
                    }
                }
                
                mstore(0, 0x095ea7b300000000000000000000000000000000000000000000000000000000)
                mstore(4, and(spender, 0xffffffffffffffffffffffffffffffffffffffff))
                mstore(36, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
                let success3 := call(gas(), token, 0, 0, 68, 0, 32)
                let valid3 := 0
                switch success3
                case 1 {
                    switch returndatasize()
                    case 0 { valid3 := 1 }
                    case 32 { if mload(0) { valid3 := 1 } }
                }
                if iszero(valid3) {
                    mstore(0, 0x1b6c83ab00000000000000000000000000000000000000000000000000000000)
                    mstore(4, token)
                    mstore(36, spender)
                    revert(0, 68)
                }
            }
        }
    }
}

