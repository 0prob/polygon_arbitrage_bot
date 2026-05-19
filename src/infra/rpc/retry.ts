import type { LoggerFn } from "../../core/types/common.ts";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryable?: (err: unknown) => boolean;
  logger?: LoggerFn;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.reason === "string") return record.reason;
  }
  return String(err);
}

export function isRateLimitError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  const errObj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined;
  const status = errObj?.status ?? errObj?.statusCode;
  if (status === 429) return true;
  return msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("429");
}

export function isAuthError(err: unknown): boolean {
  const errObj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined;
  const status = errObj?.status ?? errObj?.statusCode;
  if (status === 401) return true;
  const msg = errorMessage(err).toLowerCase();
  if (status === 403) {
    return msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("invalid api key");
  }
  return msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("401");
}

export function isRetryableError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (isAuthError(err)) return false;
  const msg = errorMessage(err).toLowerCase();
  const errObj = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined;
  const status = errObj?.status ?? errObj?.statusCode;
  const httpStatus = Number(status);
  if (Number.isInteger(httpStatus) && httpStatus >= 400) {
    return httpStatus >= 500;
  }
  return (
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    /\b50[0-9]\b|\b5[0-9]{2}\b/.test(msg) ||
    msg.includes("-32000") ||
    msg.includes("header not found") ||
    msg.includes("missing trie node") ||
    msg.includes("http request failed")
  );
}

export function isNoDataError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes('returned no data ("0x")') || msg.includes("no data");
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = opts.baseDelay ?? DEFAULT_BASE_DELAY;
  const maxDelay = opts.maxDelay ?? DEFAULT_MAX_DELAY;
  const retryable = opts.retryable ?? isRetryableError;
  const logger = opts.logger ?? null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!retryable(err) || attempt === maxAttempts) {
        throw err;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1) + Math.random() * 200, maxDelay);
      logger?.(`[retry] attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(delay)}ms: ${errorMessage(err)}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("withRetry: unreachable");
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
      }),
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
