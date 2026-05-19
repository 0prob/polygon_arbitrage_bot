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
  if (_moduleError !== null && !shouldRetryLoad()) return;
  try {
    const mod = await import("@envio-dev/hypersync-client");
    _module = mod as Record<string, unknown>;
    _moduleError = null;
  } catch (err) {
    _moduleError = err instanceof Error ? err : new Error(String(err));
  }
}

let _lastModuleAttempt = 0;
function shouldRetryLoad(): boolean {
  const now = Date.now();
  if (now - _lastModuleAttempt < 10_000) return false;
  _lastModuleAttempt = now;
  return true;
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

let _defaultUrl = "https://polygon.hypersync.xyz";
let _defaultApiToken = "";

export function setHypersyncDefaults(url: string, apiToken: string): void {
  _defaultUrl = url;
  _defaultApiToken = apiToken;
}

let _clientPromise: Promise<HypersyncClientRuntime> | null = null;

function ensureClient(): Promise<HypersyncClientRuntime> {
  if (!_clientPromise) {
    _clientPromise = createHypersyncClient({
      url: _defaultUrl,
      apiToken: _defaultApiToken,
    }).catch((err) => {
      _clientPromise = null;
      throw err;
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

function throwUnsupportedHyperSync(): never {
  throw createHyperSyncUnavailableError(new Error("HyperSync LogDecoder unavailable on this runtime"));
}

function tryCreateDecoder(): { fromSignatures: (sigs: string[]) => HypersyncDecoderRuntime } | null {
  try {
    const req = createRequire(import.meta.url);
    const mod = req("@envio-dev/hypersync-client") as Record<string, unknown>;
    const LogDecoderCtor = mod.Decoder as
      | {
          new (): HypersyncDecoderRuntime;
          fromSignatures: (sigs: string[]) => HypersyncDecoderRuntime;
        }
      | undefined;
    if (LogDecoderCtor?.fromSignatures) {
      return {
        fromSignatures: (sigs: string[]) => LogDecoderCtor.fromSignatures(sigs),
      };
    }
  } catch {
    // native module not available
  }
  return null;
}

let _decoderFactory: { fromSignatures: (sigs: string[]) => HypersyncDecoderRuntime } | null = null;

export const Decoder: { fromSignatures: (signatures: string[]) => HypersyncDecoderRuntime } = {
  fromSignatures(signatures: string[]): HypersyncDecoderRuntime {
    if (!_decoderFactory) {
      _decoderFactory = tryCreateDecoder();
    }
    if (_decoderFactory) {
      return _decoderFactory.fromSignatures(signatures);
    }
    return {
      decodeLogs: async () => {
        throwUnsupportedHyperSync();
      },
    };
  },
};
