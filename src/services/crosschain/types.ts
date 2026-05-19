export interface CrossChainRoute {
  escrowToken: `0x${string}`;   // Token on Polygon
  escrowAmount: bigint;         // Escrow commitment
  flashPool: `0x${string}`;     // Sushi pool to flash-swap from (on Katana)
  flashProtocol: 2 | 3;         // V2 or V3
  flashAmount: bigint;          // Amount to flash-swap
  swapPath: Array<{
    pool: `0x${string}`;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    protocol: 2 | 3;
  }>;
  profitToken: `0x${string}`;   // Token to hold profit in (vbWETH/vbUSDC)
  expectedProfit: bigint;       // Expected profit in wei
  minProfitOut: bigint;         // Minimum acceptable output (slippage-adjusted)
}

export interface KatanaPoolState {
  address: `0x${string}`;
  protocol: "sushiswap_v2" | "sushiswap_v3";
  reserve0?: bigint;
  reserve1?: bigint;
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  tick?: number;
}

export interface PolygonPoolState {
  address: `0x${string}`;
  protocol: string;
  reserve0?: bigint;
  reserve1?: bigint;
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  tick?: number;
}
