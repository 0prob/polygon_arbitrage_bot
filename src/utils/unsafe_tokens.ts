// Tokens blacklisted from flash-loan arbitrage execution.
// These tokens have transfer restrictions, taxes, or fee-on-transfer behavior
// that makes Balancer flash-loan arbitrage incompatible.
// Format: lowercase hex addresses.
const UNSAFE_TOKENS = new Set<string>([
  // LGNS (Longinus) — taxed/transfer-restricted token previously seen reverting
  // on both Tenderly and Alchemy RPCs during DAI→LGNS→DAI flash-loan arbs.
  "0xeb51d9a39ad5eef215dc0bf39a8821ff804a0f01",
]);

export function unsafeExecutionTokenReason(tokenAddresses: string[]): string | null {
  for (const addr of tokenAddresses) {
    if (UNSAFE_TOKENS.has(addr.toLowerCase())) {
      return `token ${addr} is blacklisted for execution`;
    }
  }
  return null;
}
