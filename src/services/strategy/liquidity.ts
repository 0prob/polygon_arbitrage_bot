function extractReserves(state: Record<string, unknown>): [bigint | undefined, bigint | undefined] {
  const r0 = state.reserve0;
  const r1 = state.reserve1;
  if (typeof r0 === "bigint" && typeof r1 === "bigint") return [r0, r1];
  const balances = state.balances;
  if (Array.isArray(balances) && balances.length >= 2) {
    return [toBigintOrUndefined(balances[0]), toBigintOrUndefined(balances[1])];
  }
  return [undefined, undefined];
}

function toBigintOrUndefined(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return undefined;
}

export function poolLiquidityWmatic(poolState: Record<string, unknown>, tokenDecimals: number, maticPrice: number): number {
  const [reserve0, reserve1] = extractReserves(poolState);
  if (reserve0 == null || reserve1 == null) return 0;
  const tvl0 = (Number(reserve0) * maticPrice) / Math.pow(10, tokenDecimals);
  const tvl1 = (Number(reserve1) * maticPrice) / Math.pow(10, tokenDecimals);
  return Math.min(tvl0, tvl1);
}
