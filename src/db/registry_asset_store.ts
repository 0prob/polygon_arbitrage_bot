import type { CompatDatabase } from "./sqlite.ts";
import { RegistryAssetCache } from "./registry_asset_cache.ts";
import {
  batchUpsertTokenMeta as batchUpsertTokenMetaRecord,
  getAllTokenAddresses as getAllTokenAddressesRecord,
  getPoolFee as getPoolFeeRecord,
  getTokenDecimals as getTokenDecimalsRecord,
  getTokenMeta as getTokenMetaRecord,
  upsertPoolFee as upsertPoolFeeRecord,
  upsertTokenMeta as upsertTokenMetaRecord,
} from "./registry_assets.ts";

export class RegistryAssetStore {
  readonly cache: RegistryAssetCache;
  private readonly db: CompatDatabase;

  constructor(db: CompatDatabase) {
    this.db = db;
    this.cache = new RegistryAssetCache();
  }

  invalidateCaches() {
    this.cache.clear();
  }

  invalidatePoolFeeCacheEntry(poolAddress: string | null | undefined) {
    this.cache.invalidatePoolFeeEntry(poolAddress);
  }

  upsertTokenMeta(address: string, decimals: number, symbol: string | null = null, name: string | null = null) {
    upsertTokenMetaRecord(this.db, address, decimals, symbol, name);
    this.cache.refreshTokenMetaAfterWrite(address, decimals, symbol, name);
  }

  getTokenMeta(address: string) {
    return this.cache.getTokenMeta(
      address,
      (normalizedAddress) => getTokenMetaRecord(this.db, normalizedAddress),
    );
  }

  getTokenDecimals(addresses: string[]) {
    return this.cache.getTokenDecimals(
      addresses,
      (misses) => getTokenDecimalsRecord(this.db, misses),
    );
  }

  batchUpsertTokenMeta(tokens: Array<{ address: string; decimals: number; symbol?: string; name?: string }>) {
    const result = batchUpsertTokenMetaRecord(this.db, tokens);
    this.cache.refreshBatchTokenMetaAfterWrite(result?.tokens ?? []);
    return result;
  }

  upsertPoolFee(poolAddress: unknown, feeBps: unknown, feeRaw: string | null = null, protocol: string | null = null) {
    upsertPoolFeeRecord(this.db, poolAddress, feeBps, feeRaw, protocol);
    this.invalidatePoolFeeCacheEntry(String(poolAddress ?? ""));
  }

  getAllTokenAddresses() {
    return getAllTokenAddressesRecord(this.db);
  }

  getPoolFee(poolAddress: string) {
    return this.cache.getPoolFee(
      poolAddress,
      (normalizedAddress) => getPoolFeeRecord(this.db, normalizedAddress),
    );
  }
}
