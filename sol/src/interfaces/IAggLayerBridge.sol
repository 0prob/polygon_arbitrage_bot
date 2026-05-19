// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IAggLayerBridge {
    function bridgeAsset(
        address token,
        uint256 amount,
        uint32 destinationNetwork,
        address callAddress,
        address fallbackAddress,
        bytes calldata callData,
        bool forceUpdateGlobalExitRoot
    ) external;

    function bridgeMessage(
        uint32 destinationNetwork,
        address callAddress,
        address fallbackAddress,
        bool forceUpdateGlobalExitRoot,
        bytes calldata callData
    ) external;

    function proveTransaction(
        bytes calldata proof,
        uint256[2] calldata proof1,
        bytes32 root,
        bytes calldata transaction
    ) external view returns (bool);
}
