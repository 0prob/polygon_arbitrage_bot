const protocolCache = new Map<string, string>();

export function normalizeProtocol(raw: string): string {
  const cached = protocolCache.get(raw);
  if (cached !== undefined) return cached;
  const u = raw.toUpperCase();
  let res = u;
  if (u.startsWith("CURVE")) res = "CURVE";
  else if (u.startsWith("BALANCER")) res = "BALANCER";
  else if (u.startsWith("DODO")) res = "DODO";
  else if (u.startsWith("WOOFI")) res = "WOOFI";
  else if (u === "UNISWAP_V4" || u.includes("V4")) res = "V4";
  else if (u.includes("V3") || u === "KYBERSWAP_ELASTIC") res = "V3";
  else if (u.includes("V2")) res = "V2";
  protocolCache.set(raw, res);
  return res;
}

const feeUnitDivisorCache = new Map<string, bigint>();

/**
 * Convert a protocol-native fee value into basis points.
 *
 * PoolMeta.fee (and therefore SwapEdge.feeBps) carries the RAW value emitted by
 * each protocol's factory, and the units differ:
 *   - V2 forks / Balancer / DODO: basis points (1e4 = 100%)        → 30 = 0.30%
 *   - Uniswap/Sushi/Quick V3, Uniswap V4: pips (1e6 = 100%)        → 3000 = 0.30%
 *   - KyberSwap Elastic, WooFi: fee units (1e5 = 100%)             → 300 = 0.30%
 *
 * Routing/scoring math (feeLogWeight, Bellman-Ford edge weights) needs a common
 * unit; treating raw V3 pips as bps overstated V3 fees 100x and systematically
 * mis-ranked cycles. Simulation/calldata paths keep using the raw value.
 */
export function feeToBps(protocol: string, rawFee: bigint): bigint {
  let divisor = feeUnitDivisorCache.get(protocol);
  if (divisor === undefined) {
    const u = protocol.toUpperCase();
    if (u.includes("ELASTIC") || u.startsWith("WOOFI")) divisor = 10n;
    else if (u.includes("V3") || u.includes("V4")) divisor = 100n;
    else divisor = 1n;
    feeUnitDivisorCache.set(protocol, divisor);
  }
  return rawFee / divisor;
}
