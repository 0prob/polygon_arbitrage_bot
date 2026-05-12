import { normalizeEvmAddress, ZERO_ADDRESS } from "../utils/identity.ts";

export {
  isEvmAddress,
  normalizeEvmAddress,
  ZERO_ADDRESS,
} from "../utils/identity.ts";

const tokenCache = new WeakMap<object, string[]>();
const metadataCache = new WeakMap<object, Record<string, unknown>>();
const MAX_JSON_UNWRAP_DEPTH = 3;

type PoolRecordLike = {
  tokens?: unknown;
  metadata?: unknown;
};

function asPoolObject(value: unknown): (PoolRecordLike & object) | null {
  return value && typeof value === "object" ? (value as PoolRecordLike & object) : null;
}

export function parsePoolTokensValue(value: unknown): string[] {
  try {
    let parsed = value;
    for (let depth = 0; depth < MAX_JSON_UNWRAP_DEPTH && typeof parsed === "string"; depth++) {
      parsed = JSON.parse(parsed || "[]");
    }
    if (!Array.isArray(parsed)) return [];
    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      const token = normalizeEvmAddress(value);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
    return tokens;
  } catch {
    return [];
  }
}

export function parsePoolMetadataValue(value: unknown): Record<string, unknown> {
  try {
    let parsed = value ?? {};
    for (let depth = 0; depth < MAX_JSON_UNWRAP_DEPTH && typeof parsed === "string"; depth++) {
      parsed = JSON.parse(parsed || "{}");
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getPoolTokens(pool: unknown): string[] {
  const poolObject = asPoolObject(pool);
  if (!poolObject) return [];

  const cached = tokenCache.get(poolObject);
  if (cached) return cached;

  try {
    const tokens = parsePoolTokensValue(poolObject.tokens);
    tokenCache.set(poolObject, tokens);
    return tokens;
  } catch {
    tokenCache.set(poolObject, []);
    return [];
  }
}

export function getPoolMetadata(pool: unknown): Record<string, unknown> {
  const poolObject = asPoolObject(pool);
  if (!poolObject) return {};

  const cached = metadataCache.get(poolObject);
  if (cached) return cached;

  try {
    const metadata = parsePoolMetadataValue(poolObject.metadata);
    metadataCache.set(poolObject, metadata);
    return metadata;
  } catch {
    const metadata = {};
    metadataCache.set(poolObject, metadata);
    return metadata;
  }
}

export function hasZeroAddressToken(tokens: string[]): boolean {
  return tokens.some((token) => token === ZERO_ADDRESS);
}
