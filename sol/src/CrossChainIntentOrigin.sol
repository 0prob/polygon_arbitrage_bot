// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IERC20.sol";
import "./interfaces/IAggLayerBridge.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract CrossChainIntentOrigin is UUPSUpgradeable, OwnableUpgradeable {
    struct Escrow {
        address token;
        uint256 amount;
        address solver;
        address exclusiveFiller;
        uint256 deadline;
        bool claimed;
    }

    error Unauthorized();
    error AlreadyClaimed();
    error DeadlineExpired();
    error EscrowExpired();
    error NotExpiredYet();
    error InvalidProof();
    error ZeroAddress();
    error CrossChainArbDisabled();

    event OrderCreated(bytes32 indexed orderId, bytes orderData);
    event OrderClaimed(bytes32 indexed orderId);
    event OrderExpired(bytes32 indexed orderId);

    address public bridge;
    address public katanaExecutorAddr;
    uint256 public claimDelay;
    address public fallbackAddr;
    bool public enabled;

    mapping(bytes32 => Escrow) public vaults;

    modifier onlyEnabled() {
        if (!enabled) revert CrossChainArbDisabled();
        _;
    }

    function initialize(address bridge_, address katanaExecutorAddr_) public initializer {
        __Ownable_init(msg.sender);
        if (bridge_ == address(0) || katanaExecutorAddr_ == address(0)) revert ZeroAddress();
        bridge = bridge_;
        katanaExecutorAddr = katanaExecutorAddr_;
        claimDelay = 1 hours;
        fallbackAddr = msg.sender;
        enabled = true;
    }

    function setEnabled(bool enabled_) external { enabled = enabled_; }

    function executeArbOrder(address escrowToken, uint256 escrowAmount, bytes calldata orderData)
        external onlyEnabled returns (bytes32 orderId)
    {
        if (escrowToken == address(0) || escrowAmount == 0) revert ZeroAddress();
        IERC20(escrowToken).transferFrom(msg.sender, address(this), escrowAmount);
        orderId = keccak256(abi.encode(escrowToken, escrowAmount, msg.sender, block.timestamp));
        vaults[orderId] = Escrow({
            token: escrowToken,
            amount: escrowAmount,
            solver: msg.sender,
            exclusiveFiller: address(0), // decoded from orderData in production
            deadline: block.timestamp + claimDelay,
            claimed: false
        });
        emit OrderCreated(orderId, orderData);
    }

    function claimOrder(bytes32 orderId, bytes calldata proof) external {
        Escrow storage escrow = vaults[orderId];
        if (escrow.claimed) revert AlreadyClaimed();
        if (escrow.amount == 0) revert DeadlineExpired();
        if (msg.sender != escrow.solver) revert Unauthorized();
        // Production: verify AggLayer proof references Fill event from KatanaExecutor
        // bool valid = IAggLayerBridge(bridge).proveTransaction(proof, ...);
        // if (!valid) revert InvalidProof();
        escrow.claimed = true;
        IERC20(escrow.token).transfer(escrow.solver, escrow.amount);
        emit OrderClaimed(orderId);
    }

    function withdrawUnclaimed(bytes32 orderId) external {
        Escrow storage escrow = vaults[orderId];
        if (escrow.amount == 0) revert DeadlineExpired();
        if (block.timestamp < escrow.deadline) revert NotExpiredYet();
        escrow.claimed = true;
        IERC20(escrow.token).transfer(fallbackAddr, escrow.amount);
        emit OrderExpired(orderId);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
