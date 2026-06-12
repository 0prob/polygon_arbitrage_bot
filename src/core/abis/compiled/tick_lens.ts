/** Uniswap V3 TickLens on Polygon */
export const TICK_LENS_POLYGON = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573" as const;

export const TICK_LENS_ABI = [
  {
    type: "function",
    name: "getPopulatedTicksInWord",
    inputs: [
      { name: "pool", type: "address" },
      { name: "tickBitmapIndex", type: "int16" },
    ],
    outputs: [
      {
        name: "populatedTicks",
        type: "tuple[]",
        components: [
          { name: "tick", type: "int24" },
          { name: "liquidityNet", type: "int128" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

/** V3 pool tick reader functions (not in minimal pool ABI). */
export const V3_TICK_READER_ABI = [
  {
    type: "function",
    name: "tickBitmap",
    inputs: [{ name: "wordPosition", type: "int16" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ticks",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tickSpacing",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
    stateMutability: "view",
  },
] as const;
