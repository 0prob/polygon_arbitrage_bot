import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import type { LoggerFn } from "../../core/types/common.ts";
import { isRateLimitError, isAuthError } from "./retry.ts";

const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 120_000;
const MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_METHOD = "eth_call";

function ensureHttps(url: string): string {
  if (url.startsWith("http://")) {
    return "https://" + url.slice(7);
  }
  return url;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.reason === "string") return record.reason;
  }
  return String(err);
}

export class RpcEndpoint {
  url: string;
  latencyMs: number;
  consecutiveErrors: number;
  rateLimitedUntil: number;
  errorCooldownUntil: number;
  methodUnavailableUntil: Map<string, number>;
  inFlight: number;
  client: ReturnType<typeof createPublicClient>;

  private _backoffMs: number;
  private _logger: LoggerFn | null;

  constructor(url: string, logger?: LoggerFn) {
    this.url = ensureHttps(url);
    this.latencyMs = Infinity;
    this.consecutiveErrors = 0;
    this.rateLimitedUntil = 0;
    this.errorCooldownUntil = 0;
    this.methodUnavailableUntil = new Map();
    this.inFlight = 0;
    this._backoffMs = INITIAL_BACKOFF_MS;
    this._logger = logger ?? null;

    this.client = createPublicClient({
      chain: polygon,
      transport: http(this.url, {
        batch: true,
        timeout: 20_000,
        fetchOptions: { headers: { Connection: "keep-alive" } },
      }),
      batch: {
        multicall: { wait: 16 },
      },
    });
  }

  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  isCoolingDown(): boolean {
    return Date.now() < this.errorCooldownUntil;
  }

  isMethodUnavailable(method: string): boolean {
    const until = this.methodUnavailableUntil.get(method);
    return until != null && Date.now() < until;
  }

  isUnavailable(): boolean {
    return this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || this.isRateLimited() || this.isCoolingDown();
  }

  markRateLimited(method: string = DEFAULT_METHOD): void {
    const cooldownMs = this._backoffMs;
    this.rateLimitedUntil = Date.now() + cooldownMs;
    this.errorCooldownUntil = Date.now() + Math.max(cooldownMs, 5_000);
    this._backoffMs = Math.min(Math.max(cooldownMs * 2, INITIAL_BACKOFF_MS), MAX_BACKOFF_MS);
    this.consecutiveErrors++;
    this._logger?.(`[rpc] rate-limited on ${this.url} for ${method}, backoff=${cooldownMs}ms`);
  }

  markError(method: string = DEFAULT_METHOD): void {
    const cooldownMs = this._backoffMs;
    this.errorCooldownUntil = Date.now() + cooldownMs;
    this._backoffMs = Math.min(Math.max(cooldownMs * 2, INITIAL_BACKOFF_MS), MAX_BACKOFF_MS);
    this.consecutiveErrors++;
    this._logger?.(`[rpc] error on ${this.url} for ${method}`);
  }

  markSuccess(): void {
    this.consecutiveErrors = 0;
    if (!this.isRateLimited() && !this.isCoolingDown()) {
      this._backoffMs = INITIAL_BACKOFF_MS;
      this.errorCooldownUntil = 0;
    }
  }
}

export interface EndpointPoolOptions {
  urls: string[];
  logger?: LoggerFn;
}

export class RpcEndpointPool {
  endpoints: RpcEndpoint[];
  private _probeInterval: ReturnType<typeof setInterval> | null;
  private _nextIndex: number;

  constructor(opts: EndpointPoolOptions) {
    if (!opts.urls || opts.urls.length === 0) {
      throw new Error("RpcEndpointPool: at least one RPC URL required");
    }
    this.endpoints = opts.urls.map((u) => new RpcEndpoint(u, opts.logger));
    this._probeInterval = null;
    this._nextIndex = 0;
  }

  getBestEndpoint(method: string = DEFAULT_METHOD): RpcEndpoint {
    const available = this.endpoints.filter((ep) => !ep.isMethodUnavailable(method));
    const healthy = available.filter((ep) => !ep.isRateLimited() && !ep.isCoolingDown());
    if (healthy.length > 0) {
      healthy.sort((a, b) => {
        const scoreA = a.latencyMs + a.inFlight * 50;
        const scoreB = b.latencyMs + b.inFlight * 50;
        return scoreA - scoreB;
      });
      return this._tieBreak(healthy);
    }
    const cooling = available.filter((ep) => !ep.isRateLimited());
    if (cooling.length > 0) {
      cooling.sort((a, b) => a.errorCooldownUntil - b.errorCooldownUntil);
      return cooling[0];
    }
    available.sort((a, b) => a.rateLimitedUntil - b.rateLimitedUntil);
    return available[0];
  }

  checkoutBestEndpoint(method: string = DEFAULT_METHOD): RpcEndpoint {
    const ep = this.getBestEndpoint(method);
    ep.inFlight++;
    const timer = setTimeout(() => {
      ep.inFlight = Math.max(0, ep.inFlight - 1);
    }, 30_000);
    timer.unref();
    (ep as any)._safetyTimer = timer;
    return ep;
  }

  releaseEndpoint(url: string): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (!ep) return;
    const timer = (ep as any)._safetyTimer as ReturnType<typeof setTimeout> | undefined;
    if (timer) {
      clearTimeout(timer);
      (ep as any)._safetyTimer = null;
    }
    ep.inFlight = Math.max(0, ep.inFlight - 1);
  }

  markRateLimited(url: string, method: string = DEFAULT_METHOD): void {
    this.endpoints.find((e) => e.url === url)?.markRateLimited(method);
  }

  markError(url: string, method: string = DEFAULT_METHOD): void {
    this.endpoints.find((e) => e.url === url)?.markError(method);
  }

  markSuccess(url: string): void {
    this.endpoints.find((e) => e.url === url)?.markSuccess();
  }

  markAuthFailed(url: string): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (ep) ep.errorCooldownUntil = Date.now() + 3_600_000;
  }

  markMethodUnavailable(url: string, method: string): void {
    const ep = this.endpoints.find((e) => e.url === url);
    if (!ep) return;
    if (method === "eth_call" || method === "eth_blockNumber" || method === "getBlockNumber") {
      ep.markError(method);
      return;
    }
    ep.methodUnavailableUntil.set(method, Date.now() + 60_000);
  }

  start(): void {
    if (this._probeInterval) return;
    for (const ep of this.endpoints) {
      this._probeEndpoint(ep).catch(() => {});
    }
    this._probeInterval = setInterval(() => {
      for (const ep of this.endpoints) {
        this._probeEndpoint(ep).catch(() => {});
      }
    }, PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this._probeInterval) {
      clearInterval(this._probeInterval);
      this._probeInterval = null;
    }
  }

  private async _probeEndpoint(ep: RpcEndpoint): Promise<void> {
    const start = Date.now();
    try {
      await Promise.race([
        ep.client.getBlockNumber(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS)),
      ]);
      ep.latencyMs = Date.now() - start;
      ep.markSuccess();
    } catch {
      ep.markError();
    }
  }

  private _tieBreak(candidates: RpcEndpoint[]): RpcEndpoint {
    if (candidates.length <= 1) return candidates[0];
    const idx = this._nextIndex++ % candidates.length;
    return candidates[idx];
  }
}

function normalizeRpcMethod(prop: string | symbol): string {
  if (typeof prop !== "string") return DEFAULT_METHOD;
  switch (prop) {
    case "getBlockNumber":
      return "eth_blockNumber";
    case "getBalance":
      return "eth_getBalance";
    case "getBlock":
      return "eth_getBlockByNumber";
    case "call":
      return "eth_call";
    case "getLogs":
      return "eth_getLogs";
    case "getTransaction":
      return "eth_getTransactionByHash";
    case "getTransactionCount":
      return "eth_getTransactionCount";
    case "getTransactionReceipt":
    case "waitForTransactionReceipt":
      return "eth_getTransactionReceipt";
    case "estimateGas":
      return "eth_estimateGas";
    case "sendRawTransaction":
      return "eth_sendRawTransaction";
    case "getFeeHistory":
      return "eth_feeHistory";
    case "getChainId":
      return "eth_chainId";
    default:
      return DEFAULT_METHOD;
  }
}

export function createDynamicPublicClient(pool: RpcEndpointPool): ReturnType<typeof createPublicClient> {
  return new Proxy({} as ReturnType<typeof createPublicClient>, {
    get(_, prop: string | symbol) {
      const method = normalizeRpcMethod(prop);
      if (prop === "transport" || prop === "chain" || prop === "key" || prop === "name") return undefined;
      if (prop === "account") return undefined;
      if (prop === "extend") return () => createDynamicPublicClient(pool);
      return async (...args: unknown[]) => {
        const endpoint = pool.checkoutBestEndpoint(method);
        try {
          const client = endpoint.client;
          const result = await (client as any)[prop](...args);
          pool.markSuccess(endpoint.url);
          return result;
        } catch (err: unknown) {
          const msg = errorMessage(err);
          const isCapErr =
            msg.includes("unsupported") ||
            msg.includes("not supported") ||
            msg.includes("method not found") ||
            msg.includes("-32601");
          if (isCapErr) {
            pool.markMethodUnavailable(endpoint.url, method);
          } else if (isRateLimitError(err)) {
            pool.markRateLimited(endpoint.url, method);
          } else if (isAuthError(err)) {
            pool.markAuthFailed(endpoint.url);
          } else {
            pool.markError(endpoint.url, method);
          }
          throw err;
        } finally {
          pool.releaseEndpoint(endpoint.url);
        }
      };
    },
  }) as unknown as ReturnType<typeof createPublicClient>;
}
