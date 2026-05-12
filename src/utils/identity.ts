/**
 * src/util/identity.ts — Shared EVM address and protocol key utilities
 *
 * Consolidated from the former src/domain/identity.ts into the util
 * directory to eliminate an unnecessary top-level directory layer.
 * Originally re-exported via util/pool_record.ts; now imported directly.
 */

export type EvmAddress = string;
export type ProtocolKey = string;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export function isFastEvmAddress(value: string) {
  if (value.length !== 42) return false;
  if (value.charCodeAt(0) !== 48) return false;
  const prefix = value.charCodeAt(1);
  if (prefix !== 120 && prefix !== 88) return false;
  for (let i = 2; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 70;
    const lower = code >= 97 && code <= 102;
    if (!digit && !upper && !lower) return false;
  }
  return true;
}

export function normalizeEvmAddress(value: unknown, options: { allowZero?: boolean } = {}): EvmAddress | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!EVM_ADDRESS_RE.test(normalized)) return null;
  if (!options.allowZero && normalized === ZERO_ADDRESS) return null;
  return normalized;
}

export function isEvmAddress(value: unknown, options: { allowZero?: boolean } = {}) {
  return normalizeEvmAddress(value, options) != null;
}

export function normalizeProtocolKey(protocol: unknown): ProtocolKey {
  return String(protocol ?? "").trim().toUpperCase();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}


export const normalizeAddress = normalizeEvmAddress;
