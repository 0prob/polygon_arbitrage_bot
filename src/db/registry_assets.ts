import { normalizeEvmAddress, normalizeProtocolKey, isRecord } from "../utils/identity.ts";
import type { CompatDatabase } from "./sqlite.ts";

type AssetDatabase = Pick<CompatDatabase, "statement" | "transaction">;

export type TokenMetaRow = {
  address: string;
  decimals: number;
  symbol: string | null;
  name: string | null;
};

export type PoolFeeRow = {
  fee_bps: unknown;
  fee_raw: unknown;
};

export type PersistableTokenMeta = {
  address: string;
  decimals: number;
  symbol?: string | null;
  name?: string | null;
};

type NormalizedTokenMeta = {
  address: string;
  decimals: number;
  symbol: string | null;
  name: string | null;
};

type TokenDecimalsRow = {
  address?: unknown;
  decimals?: unknown;
};

type UpsertTokenMeta = (db: AssetDatabase, address: string, decimals: number, symbol?: string | null, name?: string | null) => unknown;

function assetStmt(db: AssetDatabase, key: string, sql: string) {
  return db.statement(key, sql);
}

function normalizeTokenAddress(address: unknown) {
  return normalizeEvmAddress(address);
}

function normalizePoolAddress(address: unknown) {
  return normalizeEvmAddress(address);
}

function normalizeTokenText(value: unknown) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function normalizePoolFeeBps(feeBps: unknown) {
  const normalized = Number(feeBps);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 10_000) {
    throw new Error(`Invalid pool fee bps: ${feeBps}`);
  }
  return normalized;
}

export function normalizeTokenDecimals(decimals: unknown) {
  const numeric = Number(decimals);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }
  return numeric;
}

export function upsertTokenMeta(db: AssetDatabase, address: unknown, decimals: unknown, symbol: unknown = null, name: unknown = null) {
  const normalizedAddress = normalizeTokenAddress(address);
  if (!normalizedAddress) {
    throw new Error("Token address is required");
  }
  assetStmt(
    db,
    "upsertTokenMeta",
    `INSERT INTO token_meta (address, decimals, symbol, name, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(address) DO UPDATE SET
         decimals   = excluded.decimals,
         symbol     = COALESCE(excluded.symbol, token_meta.symbol),
         name       = COALESCE(excluded.name, token_meta.name),
         updated_at = excluded.updated_at`,
  ).run(normalizedAddress, normalizeTokenDecimals(decimals), normalizeTokenText(symbol), normalizeTokenText(name));
}

export function getTokenMeta(db: AssetDatabase, address: unknown): TokenMetaRow | null {
  const normalizedAddress = normalizeTokenAddress(address);
  if (!normalizedAddress) return null;
  return (
    (assetStmt(db, "getTokenMeta", `SELECT address, decimals, symbol, name, updated_at FROM token_meta WHERE address = ?`).get(
      normalizedAddress,
    ) as TokenMetaRow | undefined) || null
  );
}

export function getTokenDecimals(db: AssetDatabase, addresses: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (!Array.isArray(addresses) || addresses.length === 0) return result;

  const CHUNK = 900;
  const lower = [...new Set(addresses.map(normalizeTokenAddress).filter((address): address is string => address != null))];

  for (let i = 0; i < lower.length; i += CHUNK) {
    const batch = lower.slice(i, i + CHUNK);
    const placeholders = batch.map(() => "?").join(",");
    const rows = assetStmt(
      db,
      `getTokenDecimals:${batch.length}`,
      `SELECT address, decimals FROM token_meta WHERE address IN (${placeholders})`,
    ).all(...batch) as TokenDecimalsRow[];
    for (const row of rows) {
      const normalizedAddress = normalizeTokenAddress(row.address);
      if (!normalizedAddress) continue;
      result.set(normalizedAddress, normalizeTokenDecimals(row.decimals));
    }
  }

  return result;
}

export function batchUpsertTokenMeta(db: AssetDatabase, tokens: unknown, upsertTokenMetaImpl: UpsertTokenMeta = upsertTokenMeta) {
  if (!Array.isArray(tokens) || tokens.length === 0) return { upserted: 0, skipped: 0, tokens: [] };

  const merged = new Map<string, NormalizedTokenMeta>();
  let skipped = 0;
  for (const rawToken of tokens) {
    if (!isRecord(rawToken)) {
      skipped++;
      continue;
    }
    const normalizedAddress = normalizeTokenAddress(rawToken.address);
    if (!normalizedAddress) {
      skipped++;
      continue;
    }

    const prior = merged.get(normalizedAddress);
    let decimals: number;
    try {
      decimals = normalizeTokenDecimals(rawToken.decimals);
    } catch {
      skipped++;
      continue;
    }
    const next = {
      address: normalizedAddress,
      decimals,
      symbol: normalizeTokenText(rawToken.symbol),
      name: normalizeTokenText(rawToken.name),
    };

    merged.set(normalizedAddress, {
      ...prior,
      ...next,
      symbol: next.symbol ?? prior?.symbol ?? null,
      name: next.name ?? prior?.name ?? null,
    });
  }

  if (merged.size === 0) return { upserted: 0, skipped, tokens: [] };

  const persisted = [...merged.values()];
  const upsertTokens = db.transaction((list: unknown) => {
    let changes = 0;
    const normalizedList = Array.isArray(list) ? (list as NormalizedTokenMeta[]) : [];
    for (const t of normalizedList) {
      upsertTokenMetaImpl(db, t.address, t.decimals, t.symbol, t.name);
      changes++;
    }
    return changes;
  });
  const upserted = Number(upsertTokens(persisted));

  return { upserted, skipped, tokens: persisted };
}

export function upsertPoolFee(db: AssetDatabase, poolAddress: unknown, feeBps: unknown, feeRaw: unknown = null, protocol: unknown = null) {
  const normalizedAddress = normalizePoolAddress(poolAddress);
  if (!normalizedAddress) {
    throw new Error("Pool address is required");
  }
  const normalizedFeeBps = normalizePoolFeeBps(feeBps);
  const normalizedProtocol = protocol == null ? null : normalizeProtocolKey(protocol);
  const normalizedFeeRaw = feeRaw == null ? null : String(feeRaw);

  assetStmt(
    db,
    "upsertPoolFee",
    `INSERT INTO pool_fees (address, fee_bps, fee_raw, protocol, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(address) DO UPDATE SET
         fee_bps    = excluded.fee_bps,
         fee_raw    = excluded.fee_raw,
         protocol   = COALESCE(excluded.protocol, pool_fees.protocol),
         updated_at = excluded.updated_at`,
  ).run(normalizedAddress, normalizedFeeBps, normalizedFeeRaw, normalizedProtocol);
}

export function getAllTokenAddresses(db: AssetDatabase): string[] {
  const rows = assetStmt(db, "getAllTokenAddresses", `SELECT address FROM token_meta ORDER BY address`).all() as { address?: unknown }[];
  return rows.map((row) => normalizeTokenAddress(row.address)).filter((addr): addr is string => addr != null);
}

export function getPoolFee(db: AssetDatabase, poolAddress: unknown) {
  const normalizedAddress = normalizePoolAddress(poolAddress);
  if (!normalizedAddress) return null;

  const row = assetStmt(db, "getPoolFee", `SELECT fee_bps, fee_raw FROM pool_fees WHERE address = ?`).get(normalizedAddress) as
    | PoolFeeRow
    | undefined;
  return row
    ? {
        feeBps: normalizePoolFeeBps(row.fee_bps),
        feeRaw: row.fee_raw != null ? String(row.fee_raw) : null,
      }
    : null;
}
