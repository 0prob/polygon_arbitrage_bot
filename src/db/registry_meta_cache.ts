import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { loadPoolMetaCache } from "./registry_pools.ts";
import type { CompatDatabase } from "./sqlite.ts";

type RegistryStatementFactory = (key: string, sql: string) => ReturnType<CompatDatabase["statement"]>;

export type RegistryPoolMeta = {
  pool_address: string;
  protocol: string;
  tokens: unknown;
  metadata?: unknown;
  status?: string;
  state?: { data?: Record<string, unknown> } | null;
  [key: string]: unknown;
};

type PoolMetaMap = Map<string, RegistryPoolMeta>;

export class RegistryMetaCache {
  private readonly _stmt: RegistryStatementFactory;
  private _poolMetaCache: PoolMetaMap | null;
  private _activePoolMetaCache: RegistryPoolMeta[] | null;
  private _activePoolMetaByAddressCache: PoolMetaMap | null;

  constructor(stmt: RegistryStatementFactory) {
    this._stmt = stmt;
    this._poolMetaCache = null;
    this._activePoolMetaCache = null;
    this._activePoolMetaByAddressCache = null;
  }

  invalidate() {
    this._poolMetaCache = null;
    this._activePoolMetaCache = null;
    this._activePoolMetaByAddressCache = null;
  }

  getAll() {
    if (!this._poolMetaCache) {
      this._poolMetaCache = loadPoolMetaCache(this._stmt) as PoolMetaMap;
    }
    return this._poolMetaCache;
  }

  getActive() {
    if (!this._activePoolMetaCache) {
      const activePools = loadPoolMetaCache(this._stmt, "active") as RegistryPoolMeta[];
      this._activePoolMetaCache = activePools;
      this._activePoolMetaByAddressCache = new Map(activePools.map((pool) => [pool.pool_address, pool]));
    }
    return this._activePoolMetaCache;
  }

  get(address: unknown) {
    const normalizedAddress = normalizeEvmAddress(address);
    if (!normalizedAddress) return undefined;

    if (this._activePoolMetaByAddressCache?.has(normalizedAddress)) {
      return this._activePoolMetaByAddressCache.get(normalizedAddress);
    }
    if (this._poolMetaCache) {
      return this._poolMetaCache.get(normalizedAddress);
    }
    return this.getAll().get(normalizedAddress);
  }
}
