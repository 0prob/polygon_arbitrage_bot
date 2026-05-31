// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library UniswapV3Library {
    bytes32 internal constant V3_INIT_HASH = 0xe040f12c7cee3904b78f24f8fc395629c2e69525c2815da7a659f7483e378ecb;

    function computeAddress(address factory, address token0, address token1, uint24 fee)
        internal
        pure
        returns (address pool)
    {
        require(token0 < token1);
        pool = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(hex"ff", factory, keccak256(abi.encode(token0, token1, fee)), V3_INIT_HASH)
                    )
                )
            )
        );
    }
}
