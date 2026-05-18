export function poolLiquidityWmatic(
  poolState: Record<string, unknown>, tokenDecimals: number, maticPrice: number,
): number {
  const reserve0 = poolState.reserve0;
  const reserve1 = poolState.reserve1;
  if (typeof reserve0 !== "bigint" || typeof reserve1 !== "bigint") return 0;
  const tvl0 = Number(reserve0) * maticPrice / Math.pow(10, tokenDecimals);
  const tvl1 = Number(reserve1) * maticPrice / Math.pow(10, tokenDecimals);
  return Math.min(tvl0, tvl1);
}
