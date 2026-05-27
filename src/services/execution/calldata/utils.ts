import { getAddress } from "viem";
import { MAX_UINT24, BPS_DENOMINATOR } from "./constants.ts";

export function asAddress(value: unknown): `0x${string}` {
  return getAddress(String(value));
}

export function normalizeUint(value: unknown, label: string): bigint {
  try {
    const n = BigInt(value as string | number | bigint | boolean);
    if (n < 0n) throw new Error("negative");
    return n;
  } catch (_err: unknown) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

export function normalizePositiveUint(value: unknown, label: string): bigint {
  const n = normalizeUint(value, label);
  if (n <= 0n) throw new Error(`${label} must be > 0`);
  return n;
}

export function normalizeUint24(value: unknown, label: string): number {
  const n = normalizeUint(value, label);
  if (n > MAX_UINT24) throw new Error(`${label} must fit uint24`);
  return Number(n);
}

export function normalizeSlippageBps(value: unknown): number {
  const n = Number(value ?? 50);
  if (!Number.isSafeInteger(n) || n < 0 || n > BPS_DENOMINATOR) {
    throw new Error("slippageBps must be an integer between 0 and 10000");
  }
  return n;
}

export function slippageAdjustedAmountOut(amountOut: unknown, slippageBps: unknown, label: string): bigint {
  const output = normalizePositiveUint(amountOut, `${label} amountOut`);
  const bps = normalizeSlippageBps(slippageBps);
  const minOut = (output * BigInt(BPS_DENOMINATOR - bps)) / BigInt(BPS_DENOMINATOR);
  if (minOut <= 0n) throw new Error(`${label} minimum output must be > 0`);
  return minOut;
}

export function normalizeBytes32(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : null;
}
