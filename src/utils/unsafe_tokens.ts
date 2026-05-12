const UNSAFE_TOKENS = new Set<string>();

export function unsafeExecutionTokenReason(tokenAddresses: string[]): string | null {
  for (const addr of tokenAddresses) {
    if (UNSAFE_TOKENS.has(addr.toLowerCase())) {
      return `token ${addr} is blacklisted for execution`;
    }
  }
  return null;
}
