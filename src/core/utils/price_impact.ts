export function getEffectivePriceImpact(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  // Simple impact calculation: (amountIn / reserveIn) - (amountOut / reserveOut)
  // Scaled by 10000 for basis points representation
  if (reserveIn === 0n || reserveOut === 0n) return 0n;

  // (amountIn * 10000 / reserveIn) - (amountOut * 10000 / reserveOut)
  const impactIn = (amountIn * 10000n) / reserveIn;
  const impactOut = (amountOut * 10000n) / reserveOut;

  if (impactIn > impactOut) return impactIn - impactOut;
  return 0n;
}
