// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IVaultBridge {
    function previewWithdraw(address token, uint256 shares) external view returns (uint256);
    function exchangeRate(address token) external view returns (uint256);
    function getTokenWrappedAddress(uint32 networkID, address originTokenAddress) external view returns (address);
}
