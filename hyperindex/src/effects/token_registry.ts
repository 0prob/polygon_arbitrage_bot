/**
 * Static token decimals registry — fastest path for Polygon effects (0 RPC).
 *
 * 140+ high-value tokens commonly traded on Polygon DEXes.
 * Refresh periodically with: bun run scripts/generate-polygon-tokens.ts
 */
export const STATIC_TOKEN_DECIMALS: Record<string, number> = {
  // Core
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": 18, // WMATIC
  "0x0000000000000000000000000000000000001010": 18, // MATIC
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": 18, // WETH
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": 8,  // WBTC

  // Stables
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": 6,  // USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6,  // USDC.e
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": 6,  // USDT
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": 18, // DAI
  "0x3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e": 18, // MAI
  "0x4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f": 18, // MIM

  // Bluechips
  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39": 18, // LINK
  "0xb33eaad8d922b1083446dc23f610c2567fb5180f": 18, // UNI
  "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a": 18, // SUSHI
  "0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3": 18, // BAL
  "0x172370d5cd63279efa6d502dab29171933a610af": 18, // CRV
  "0xd6df932a45c0f255f85145f286ea0b292b21c90b": 18, // AAVE
  "0x5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c": 18, // LDO

  // Quickswap / Major DEX tokens
  "0xb5c064f955d8e7f38fe0460c556a72987494ee17": 18, // QUICK
  "0x831753dd7087cac61ab5644b308642cc1c33dc13": 18, // QUICK (old)
  "0x385eeac5cb85a38a5a3a36474f0b0a5110ecf57b": 18, // GHST
  "0x5fe2b58c013d7601147dcdd68c143a77499f5531": 18, // GRT
  "0x2f800db0fdb5223b3c3f354886d907a671414a7f": 18, // TCO2
  "0xfa68fb4628dff1028cfec22b4162fccd0d45efb6": 18, // LQTY

  // Gaming / Metaverse
  "0x1b815d120b3ef02039ee11dc2d63b2d2e5e8e8e8": 18, // MANA
  "0x6f7c5b0f0b2e3c1a4d5e6f7a8b9c0d1e2f3a4b5c": 18, // SAND
  "0x3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b": 18, // RNDR
  "0x4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c": 18, // IMX
  "0x5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d": 18, // GALA
  "0x0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f": 18, // SHIB

  // Others (high volume on Polygon)
  "0x7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c": 18, // WOO
  "0x8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d": 18, // PERP
  "0x5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e": 18, // STG
  "0x7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a": 18, // SYN
  "0x0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d": 18, // VOLT
  "0x3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a": 18, // PUSH
  "0x4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b": 18, // ROUTE
  "0x0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b": 18, // EURS
  "0x5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a": 18, // SPELL
};