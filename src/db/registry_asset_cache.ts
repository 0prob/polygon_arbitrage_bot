import { normalizeEvmAddress } from "../utils/identity.ts";
import { normalizeTokenDecimals } from "./registry_assets.ts";

export type CachedTokenMeta = {
  address: string;
  decimals: number;
  symbol: string | null;
  name: string | null;
};

export type CachedPoolFee = {
  feeBps: number;
  feeRaw: string | null;
};

export class RegistryAssetCache {
  tokenMetaCache = new Map<string, CachedTokenMeta | null>();
  tokenDecimalsCache = new Map<string, number>();
  poolFeeCache = new Map<string, CachedPoolFee | null>();

  normalizeTokenAddress(address: string | null | undefined) {
    return normalizeEvmAddress(address);
  }

  normalizePoolAddress(address: string | null | undefined) {
    return normalizeEvmAddress(address);
  }

  normalizeTokenText(value: string | null | undefined) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  }

  clear() {
    this.tokenMetaCache.clear();
    this.tokenDecimalsCache.clear();
    this.poolFeeCache.clear();
  }

  getTokenMeta(
    address: string,
    fetchMeta: (normalizedAddress: string) => {
      address?: string | null;
      decimals?: number | null;
      symbol?: string | null;
      name?: string | null;
    } | null,
  ) {
    const normalizedAddress = this.normalizeTokenAddress(address);
    if (!normalizedAddress) return null;
    if (this.tokenMetaCache.has(normalizedAddress)) {
      return this.tokenMetaCache.get(normalizedAddress) ?? null;
    }
    return this.cacheTokenMetaEntry(fetchMeta(normalizedAddress));
  }

  getTokenDecimals(
    addresses: string[],
    fetchDecimals: (normalizedAddresses: string[]) => Map<string, number>,
  ) {
    const result = new Map<string, number>();
    if (!Array.isArray(addresses) || addresses.length === 0) return result;

    const misses: string[] = [];
    const seen = new Set<string>();
    for (const address of addresses) {
      const normalizedAddress = this.normalizeTokenAddress(address);
      if (!normalizedAddress || seen.has(normalizedAddress)) continue;
      seen.add(normalizedAddress);

      const cachedDecimals = this.tokenDecimalsCache.get(normalizedAddress);
      if (cachedDecimals != null) {
        result.set(normalizedAddress, cachedDecimals);
      } else {
        misses.push(normalizedAddress);
      }
    }

    if (misses.length === 0) return result;

    const fetched = fetchDecimals(misses);
    for (const [address, decimals] of fetched.entries()) {
      let normalizedDecimals: number;
      try {
        normalizedDecimals = normalizeTokenDecimals(decimals);
      } catch {
        this.invalidateTokenEntry(address);
        continue;
      }
      this.tokenDecimalsCache.set(address, normalizedDecimals);
      result.set(address, normalizedDecimals);
      this.patchCachedTokenDecimals(address, normalizedDecimals);
    }

    return result;
  }

  refreshTokenMetaAfterWrite(
    address: string,
    decimals: number,
    symbol: string | null = null,
    name: string | null = null,
  ) {
    const normalizedAddress = this.normalizeTokenAddress(address);
    if (!normalizedAddress) return;
    const normalizedDecimals = normalizeTokenDecimals(decimals);
    const normalizedSymbol = this.normalizeTokenText(symbol);
    const normalizedName = this.normalizeTokenText(name);
    const existingMeta = this.tokenMetaCache.get(normalizedAddress) ?? null;

    this.tokenDecimalsCache.set(normalizedAddress, normalizedDecimals);

    if (normalizedSymbol != null && normalizedName != null) {
      this.cacheTokenMetaEntry({
        address: normalizedAddress,
        decimals: normalizedDecimals,
        symbol: normalizedSymbol,
        name: normalizedName,
      });
      return;
    }
    if (existingMeta) {
      const cachedSymbol = this.normalizeTokenText(String(existingMeta.symbol ?? ""));
      const cachedName = this.normalizeTokenText(String(existingMeta.name ?? ""));
      this.cacheTokenMetaEntry({
        address: normalizedAddress,
        decimals: normalizedDecimals,
        symbol: normalizedSymbol ?? cachedSymbol,
        name: normalizedName ?? cachedName,
      });
      return;
    }
    this.tokenMetaCache.delete(normalizedAddress);
  }

  refreshBatchTokenMetaAfterWrite(tokens: Array<{
    address?: string | null;
    decimals?: number | null;
    symbol?: string | null;
    name?: string | null;
  }>) {
    for (const token of tokens) {
      if (token?.address == null || token?.decimals == null) continue;
      this.refreshTokenMetaAfterWrite(
        token.address,
        token.decimals,
        token.symbol ?? null,
        token.name ?? null,
      );
    }
  }

  getPoolFee(
    poolAddress: string,
    fetchFee: (normalizedAddress: string) => CachedPoolFee | null,
  ) {
    const normalizedAddress = this.normalizePoolAddress(poolAddress);
    if (!normalizedAddress) return null;
    if (this.poolFeeCache.has(normalizedAddress)) {
      return this.poolFeeCache.get(normalizedAddress) ?? null;
    }
    return this.cachePoolFeeEntry(normalizedAddress, fetchFee(normalizedAddress));
  }

  invalidatePoolFeeEntry(poolAddress: string | null | undefined) {
    const normalizedAddress = this.normalizePoolAddress(poolAddress);
    if (!normalizedAddress) return;
    this.poolFeeCache.delete(normalizedAddress);
  }

  private cacheTokenMetaEntry(meta: {
    address?: string | null;
    decimals?: number | null;
    symbol?: string | null;
    name?: string | null;
  } | null | undefined) {
    const normalizedAddress = this.normalizeTokenAddress(meta?.address);
    if (!normalizedAddress) return null;

    const cachedMeta = meta == null
      ? null
      : (() => {
          try {
            return {
              address: normalizedAddress,
              decimals: normalizeTokenDecimals(meta.decimals),
              symbol: this.normalizeTokenText(meta.symbol ?? null),
              name: this.normalizeTokenText(meta.name ?? null),
            };
          } catch {
            return null;
          }
        })();

    this.tokenMetaCache.set(normalizedAddress, cachedMeta);
    if (cachedMeta?.decimals != null) {
      this.tokenDecimalsCache.set(normalizedAddress, cachedMeta.decimals);
    }
    return cachedMeta;
  }

  private cachePoolFeeEntry(poolAddress: string | null | undefined, fee: CachedPoolFee | null | undefined) {
    const normalizedAddress = this.normalizePoolAddress(poolAddress);
    if (!normalizedAddress) return null;

    const cachedFee = fee == null
      ? null
      : {
          feeBps: Number(fee.feeBps),
          feeRaw: fee.feeRaw != null ? String(fee.feeRaw) : null,
        };
    this.poolFeeCache.set(normalizedAddress, cachedFee);
    return cachedFee;
  }

  private invalidateTokenEntry(address: string | null | undefined) {
    const normalizedAddress = this.normalizeTokenAddress(address);
    if (!normalizedAddress) return;
    this.tokenMetaCache.delete(normalizedAddress);
    this.tokenDecimalsCache.delete(normalizedAddress);
  }

  private patchCachedTokenDecimals(address: string, decimals: number) {
    if (!this.tokenMetaCache.has(address)) return;
    const meta = this.tokenMetaCache.get(address);
    if (meta) {
      this.tokenMetaCache.set(address, { ...meta, decimals });
    }
  }
}
