import { describe, it, expect, vi } from "vitest";
import { withRetry, withTimeout, isRateLimitError, isRetryableError, isAuthError, isNoDataError } from "./retry.ts";

describe("isRateLimitError", () => {
  it("returns true for status 429", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it("returns true for rate limit messages", () => {
    expect(isRateLimitError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("too many requests"))).toBe(true);
    expect(isRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isRateLimitError(new Error("timeout"))).toBe(false);
    expect(isRateLimitError({ status: 500 })).toBe(false);
  });
});

describe("isAuthError", () => {
  it("returns true for status 401", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
  });

  it("returns true for forbidden messages with 403", () => {
    expect(isAuthError({ status: 403, message: "unauthorized" })).toBe(true);
    expect(isAuthError({ status: 403, message: "forbidden" })).toBe(true);
    expect(isAuthError({ status: 403, message: "invalid api key" })).toBe(true);
  });

  it("returns false for 403 with non-auth message", () => {
    expect(isAuthError({ status: 403, message: "capacity reached" })).toBe(false);
  });

  it("returns true for unauthorized in message text", () => {
    expect(isAuthError(new Error("unauthorized"))).toBe(true);
    expect(isAuthError(new Error("forbidden"))).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isAuthError(new Error("timeout"))).toBe(false);
  });
});

describe("isRetryableError", () => {
  it("returns true for rate limit errors", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it("returns false for auth errors", () => {
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError(new Error("unauthorized"))).toBe(false);
  });

  it("returns true for network errors", () => {
    expect(isRetryableError(new Error("timeout"))).toBe(true);
    expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("network error"))).toBe(true);
  });

  it("returns true for 5xx status", () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
  });

  it("returns false for 4xx status (except 429)", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError({ status: 422 })).toBe(false);
  });

  it("returns true for JSON-RPC errors", () => {
    expect(isRetryableError(new Error("-32000"))).toBe(true);
    expect(isRetryableError(new Error("header not found"))).toBe(true);
    expect(isRetryableError(new Error("missing trie node"))).toBe(true);
  });
});

describe("isNoDataError", () => {
  it("returns true for no data message", () => {
    expect(isNoDataError(new Error('returned no data ("0x")'))).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isNoDataError(new Error("execution reverted"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("succeeds on first attempt if no error", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelay: 100 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds eventually", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { maxAttempts: 5, baseDelay: 5, maxDelay: 20 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("gives up after max attempts", async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error("timeout")));

    await expect(withRetry(fn, { maxAttempts: 3, baseDelay: 5, maxDelay: 20 })).rejects.toThrow("timeout");
    expect(fn).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("non-retryable error passes through immediately", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("unauthorized"));
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow("unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses custom retryable predicate", async () => {
    const customRetryable = vi.fn().mockReturnValue(true);
    const fn = vi.fn().mockRejectedValueOnce(new Error("custom")).mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelay: 5,
      maxDelay: 20,
      retryable: customRetryable,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(customRetryable).toHaveBeenCalled();
  }, 10_000);

  it("calls logger on failure", async () => {
    const logger = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelay: 5,
      maxDelay: 20,
      logger,
    });
    expect(result).toBe("ok");
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("[retry] attempt 1/3 failed, retrying in"));
  }, 10_000);
});

describe("withTimeout", () => {
  it("resolves when promise completes in time", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 100);
    expect(result).toBe("ok");
  });

  it("rejects when promise takes too long", async () => {
    await expect(withTimeout(new Promise((_) => {}), 10)).rejects.toThrow("Timeout after 10ms");
  }, 10_000);

  it("does not reject if promise resolves before timeout", async () => {
    const result = await withTimeout(new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5)), 100);
    expect(result).toBe("done");
  }, 10_000);
});
