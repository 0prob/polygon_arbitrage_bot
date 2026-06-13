/** Lowercase EVM address (pool/token/contract). Keeps 0x prefix when present. */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/** Pool map keys and graph poolAddress fields — alias for address normalization. */
export function normalizePoolAddress(address: string): string {
  return normalizeAddress(address);
}

/** Block hash comparison form: strip 0x prefix, lowercase. */
export function normalizeBlockHash(hash: string): string {
  return hash.replace(/^0x/i, "").toLowerCase();
}
