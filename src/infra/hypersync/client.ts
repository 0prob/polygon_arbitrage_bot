import { createRequire } from "module";
import type { HyperSyncClientConfig, HypersyncClientRuntime, HypersyncDecoderRuntime } from "./types.ts";

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

export function normalizeClientConfig(config: HyperSyncClientConfig): Record<string, unknown> {
  const url = String(config.url ?? "").trim();
  if (!url) throw createConfigError("url must be a non-empty string");

  const normalized: Record<string, unknown> = {
    url,
    apiToken: String(config.apiToken ?? ""),
  };

  const optionalInts: (keyof HyperSyncClientConfig)[] = [
    "httpReqTimeoutMillis",
    "maxNumRetries",
    "retryBackoffMs",
    "retryBaseMs",
    "retryCeilingMs",
  ];

  for (const key of optionalInts) {
    if (config[key] != null) {
      const normalizedValue = normalizeOptionalInt(config[key]);
      if (normalizedValue !== undefined) {
        normalized[key] = normalizedValue;
      }
    }
  }

  if (config.proactiveRateLimitSleep !== undefined) {
    normalized.proactiveRateLimitSleep = config.proactiveRateLimitSleep;
  }

  return normalized;
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
  if (_module !== null) return;
  try {
    const mod = await import("@envio-dev/hypersync-client");
    _module = mod as Record<string, unknown>;
    _moduleError = null;
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
    return createUnavailableHypersyncClientImpl(_moduleError ?? createHyperSyncUnavailableError("missing HypersyncClient export"));
  }
  try {
    return new HypersyncClientCtor(normalizeClientConfig(config));
  } catch (err) {
    return createUnavailableHypersyncClientImpl(err);
  }
}

function throwUnsupportedHyperSync(): never {
  throw createHyperSyncUnavailableError(new Error("HyperSync LogDecoder unavailable on this runtime"));
}

export async function createHypersyncDecoder(signatures: string[]): Promise<HypersyncDecoderRuntime> {
  await ensureModule();
  if (!_module) {
    return { decodeLogs: async () => { throwUnsupportedHyperSync(); } };
  }
  const LogDecoderCtor = _module.Decoder as { fromSignatures: (sigs: string[]) => HypersyncDecoderRuntime } | undefined;
  if (LogDecoderCtor?.fromSignatures) {
    return LogDecoderCtor.fromSignatures(signatures);
  }
  return { decodeLogs: async () => { throwUnsupportedHyperSync(); } };
}

// Legacy exports for backward compatibility (Polygon default)
let _singletonClient: HypersyncClientRuntime | null = null;
export const client: HypersyncClientRuntime = new Proxy({} as HypersyncClientRuntime, {
  get(_target, prop) {
    const propStr = prop as string;
    if (propStr === "then") return undefined; // Avoid proxying promises
    return async (...args: unknown[]) => {
      if (!_singletonClient) {
        _singletonClient = await createHypersyncClient({ url: "https://polygon.hypersync.xyz" });
      }
      return (_singletonClient as any)[propStr](...args);
    };
  },
});

export const Decoder = {
  fromSignatures(signatures: string[]): HypersyncDecoderRuntime {
    return {
      decodeLogs: async (logs: any[]) => {
        const d = await createHypersyncDecoder(signatures);
        return d.decodeLogs(logs);
      }
    };
  }
};

export const LogField = { Address: "Address", Data: "Data", Topic0: "Topic0", Topic1: "Topic1", Topic2: "Topic2", Topic3: "Topic3", BlockNumber: "BlockNumber", TransactionHash: "TransactionHash", LogIndex: "LogIndex", TransactionIndex: "TransactionIndex" };
export const BlockField = { Number: "Number", Timestamp: "Timestamp" };
export const JoinMode = { Default: 0, JoinAll: 1, JoinNothing: 2 };
