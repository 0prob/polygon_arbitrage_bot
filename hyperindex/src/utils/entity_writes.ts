/**
 * Helpers to minimize redundant HyperIndex DB writes.
 * PoolMeta is always written on discovery; TokenMeta is skipped when already indexed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TokenMetaContext = {
  TokenMeta: {
    get: (id: string) => Promise<{ decimals?: number } | undefined>;
    set: (entity: { id: string; address: string; decimals: number }) => void;
  };
};

export async function setTokenMetaIfMissing(
  context: TokenMetaContext,
  address: string,
  decimals: number,
): Promise<void> {
  const addr = address.toLowerCase();
  const existing = await context.TokenMeta.get(addr);
  if (existing?.decimals != null) return;
  context.TokenMeta.set({ id: addr, address: addr, decimals });
}

export async function setTokenMetasIfMissing(
  context: TokenMetaContext,
  tokens: readonly string[],
  decimals: readonly number[],
): Promise<void> {
  for (let i = 0; i < tokens.length; i++) {
    await setTokenMetaIfMissing(context, tokens[i], decimals[i]);
  }
}
