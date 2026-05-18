import type { HyperSyncClientConfig, HypersyncClientRuntime } from "./types.ts";

type HypersyncError = Error & { cause?: unknown };

function createHyperSyncUnavailableError(cause: unknown): HypersyncError {
  const err = new Error("HyperSync client is unavailable on this runtime.") as HypersyncError;
  err.name = "HyperSyncClientUnavailableError";
  err.cause = cause;
  return err;
}

function createConfigError(message: string): HypersyncError {
  const err = new Error(`HyperSync client configuration failed: ${message}`) as HypersyncError;
  err.name = "HyperSyncClientConfigError";
  return err;
}

function throwUnavailable(error?: Error): never {
  throw error ?? createHyperSyncUnavailableError(new Error("unknown HyperSync initialization failure"));
}

function normalizeOptionalInt(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  return n;
}

function normalizeClientConfig(config: HyperSyncClientConfig): Record<string, unknown> {
  const url = String(config.url ?? "").trim();
  if (!url) throw createConfigError("url must be a non-empty string");
  return {
    url,
    apiToken: String(config.apiToken ?? ""),
    ...(config.httpReqTimeoutMillis != null ? { httpReqTimeoutMillis: normalizeOptionalInt(config.httpReqTimeoutMillis) } : {}),
    ...(config.maxNumRetries != null ? { maxNumRetries: normalizeOptionalInt(config.maxNumRetries) } : {}),
    ...(config.retryBackoffMs != null ? { retryBackoffMs: normalizeOptionalInt(config.retryBackoffMs) } : {}),
    ...(config.retryBaseMs != null ? { retryBaseMs: normalizeOptionalInt(config.retryBaseMs) } : {}),
    ...(config.retryCeilingMs != null ? { retryCeilingMs: normalizeOptionalInt(config.retryCeilingMs) } : {}),
    ...(config.proactiveRateLimitSleep !== undefined ? { proactiveRateLimitSleep: config.proactiveRateLimitSleep } : {}),
  };
}

function createUnavailableHypersyncClientImpl(error: unknown): HypersyncClientRuntime {
  const err = error instanceof Error ? error : createHyperSyncUnavailableError(error);
  const throwErr = () => throwUnavailable(err);
  return {
    getHeight: async () => throwErr(),
    getChainId: async () => throwErr(),
    get: async () => throwErr(),
    getWithRateLimit: async () => throwErr(),
    stream: async () => throwErr(),
    streamHeight: async () => throwErr(),
    streamEvents: async () => throwErr(),
    collect: async () => throwErr(),
    collectEvents: async () => throwErr(),
    rateLimitInfo: () => throwErr(),
    waitForRateLimit: async () => throwErr(),
  };
}

let _module: Record<string, unknown> | null = null;
let _moduleError: Error | null = null;

async function ensureModule(): Promise<void> {
  if (_module !== null || _moduleError !== null) return;
  try {
    const mod = await import("@envio-dev/hypersync-client");
    _module = mod as Record<string, unknown>;
  } catch (err) {
    _moduleError = err instanceof Error ? err : new Error(String(err));
  }
}

export async function createHypersyncClient(config: HyperSyncClientConfig): Promise<HypersyncClientRuntime> {
  await ensureModule();
  if (!_module) {
    return createUnavailableHypersyncClientImpl(_moduleError ?? createHyperSyncUnavailableError("module unavailable"));
  }
  const HypersyncClientCtor = _module.HypersyncClient as (new (cfg: Record<string, unknown>) => HypersyncClientRuntime) | undefined;
  if (!HypersyncClientCtor) {
    return createUnavailableHypersyncClientImpl(
      _moduleError ?? createHyperSyncUnavailableError("missing HypersyncClient export"),
    );
  }
  try {
    return new HypersyncClientCtor(normalizeClientConfig(config));
  } catch (err) {
    return createUnavailableHypersyncClientImpl(err);
  }
}

let _clientPromise: Promise<HypersyncClientRuntime> | null = null;

function ensureClient(): Promise<HypersyncClientRuntime> {
  if (!_clientPromise) {
    _clientPromise = createHypersyncClient({
      url: "https://polygon.hypersync.xyz",
      apiToken: "",
    });
  }
  return _clientPromise;
}

function proxyClient(): HypersyncClientRuntime {
  return new Proxy({} as HypersyncClientRuntime, {
    get(_target, prop) {
      const propStr = prop as string;
      return (...args: unknown[]) =>
        ensureClient().then((c) => {
          const fn = (c as unknown as Record<string, unknown>)[propStr] as (...a: unknown[]) => unknown;
          return fn(...args);
        });
    },
  });
}

export const client: HypersyncClientRuntime = proxyClient();

export const LogField = {
  Address: "Address",
  Data: "Data",
  Topic0: "Topic0",
  Topic1: "Topic1",
  Topic2: "Topic2",
  Topic3: "Topic3",
  BlockNumber: "BlockNumber",
  TransactionHash: "TransactionHash",
  LogIndex: "LogIndex",
  TransactionIndex: "TransactionIndex",
};

export const BlockField = {
  Number: "Number",
  Timestamp: "Timestamp",
};

export const JoinMode = {
  Default: 0,
  JoinAll: 1,
  JoinNothing: 2,
};
