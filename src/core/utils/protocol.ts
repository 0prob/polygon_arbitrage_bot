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
  else if (u.includes("V3") || u === "KYBERSWAP_ELASTIC" || u === "UNISWAP_V4") res = "V3";
  else if (u.includes("V2")) res = "V2";
  protocolCache.set(raw, res);
  return res;
}
