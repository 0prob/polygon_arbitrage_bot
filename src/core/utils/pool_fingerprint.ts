
/** Stable fingerprint for pool-set change detection (enumeration invalidation). */
export function fingerprintPools(pools: { address: string }[]): string {
  if (pools.length === 0) return "0:";
  const addrs = pools.map((p) => p.address.toLowerCase()).sort();
  let hash = 2166136261;
  for (const a of addrs) {
    for (let i = 0; i < a.length; i++) {
      hash ^= a.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${pools.length}:${(hash >>> 0).toString(16)}`;
}
