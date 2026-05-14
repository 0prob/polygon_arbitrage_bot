/**
 * tx_sniper.ts — Multi-endpoint transaction submission for arbitrage sniping
 *
 * Broadcasts signed transactions to multiple RPC endpoints simultaneously.
 * First successful submission wins; others are ignored.
 *
 * Key features:
 * - Parallel submission to N endpoints
 * - First-response-wins semantics
 * - Tracks which endpoint succeeded for metrics
 * - Optional private mempool endpoints (Alchemy, QuickNode, etc.)
 *
 * Usage:
 * ```typescript
 * const sniper = new TransactionSniper([
 *   "https://polygon-mainnet.g.alchemy.com/v2/KEY",
 *   "https://polygon-rpc.com",
 *   "https://polygon-bor-rpc.publicnode.com",
 * ]);
 *
 * const hash = await sniper.submit(serializedTx);
 * ```
 */

import { createPublicClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { logger } from "../utils/logger.ts";
import { recordTxSubmissionTelemetry } from "../utils/metrics.ts";

// ─── Types ─────────────────────────────────────────────────────

export type SubmissionResult = {
  hash: Hex;
  endpoint: string;
  latencyMs: number;
  method: string;
};

export type SubmissionError = {
  endpoint: string;
  error: unknown;
  latencyMs: number;
};

export type SniperResult =
  | {
      success: true;
      hash: Hex;
      endpoint: string;
      latencyMs: number;
      allAttempts: (SubmissionResult | SubmissionError)[];
    }
  | {
      success: false;
      error: string;
      allAttempts: (SubmissionResult | SubmissionError)[];
    };

// ─── Constants ─────────────────────────────────────────────────

/** Timeout for individual endpoint submission */
const SUBMISSION_TIMEOUT_MS = 3_000;

/** Default submission method */
const SUBMISSION_METHOD = "eth_sendRawTransaction" as const;

// ─── Helper: Create minimal RPC transport ──────────────────────

type RpcClient = {
  request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
};

function createRpcClient(url: string): RpcClient {
  const client = createPublicClient({
    chain: polygon,
    transport: http(url, {
      timeout: SUBMISSION_TIMEOUT_MS,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
  });
  // Only expose transport.request — PublicClient has no sendRawTransaction.
  return { request: (args) => client.transport.request(args) };
}

// ─── Transaction Sniper Class ──────────────────────────────────

export class TransactionSniper {
  private readonly endpoints: string[];
  private readonly privateMempoolUrls: string[];
  private readonly clients: Map<string, RpcClient>;
  private readonly privateClients: Map<string, RpcClient>;

  /**
   * @param endpoints List of RPC URLs to broadcast to
   * @param privateMempoolUrls Optional private mempool endpoints (e.g., Alchemy private tx)
   */
  constructor(endpoints: string[], privateMempoolUrls: string[] = []) {
    if (endpoints.length === 0) {
      throw new Error("TransactionSniper requires at least one endpoint");
    }
    this.endpoints = [...endpoints];
    this.privateMempoolUrls = privateMempoolUrls;
    this.clients = new Map();
    for (const url of this.endpoints) {
      this.clients.set(url, createRpcClient(url));
    }
    this.privateClients = new Map();
    for (const url of this.privateMempoolUrls) {
      this.privateClients.set(url, createRpcClient(url));
    }
  }

  /**
   * Submit a signed transaction to all endpoints in parallel.
   * Returns the first successful submission.
   *
   * @param serializedTx Hex-encoded signed transaction
   * @returns Result with hash, winning endpoint, and latency
   */
  async submit(serializedTx: Hex): Promise<SniperResult> {
    const startTime = Date.now();

    // Build submission promises for all endpoints.
    // Errors are thrown (not returned as values) so Promise.any
    // rejects only when ALL endpoints fail, not on the first error.
    const submissionPromises = this.endpoints.map(async (url) => {
      const client = this.clients.get(url);
      if (!client) {
        throw new Error("No pre-created client for endpoint");
      }
      const endpointStart = Date.now();
      const hash = (await client.request({
        method: "eth_sendRawTransaction",
        params: [serializedTx],
      })) as Hex;
      const latencyMs = Date.now() - endpointStart;
      logger.info({ hash, endpoint: shortenUrl(url), latencyMs }, "Transaction sniper: submission successful");
      return { hash, endpoint: url, latencyMs, method: SUBMISSION_METHOD } as SubmissionResult;
    });

    try {
      // True race: first success wins. Don't wait for slow endpoints.
      const winner = await Promise.any(submissionPromises);

      recordTxSubmissionTelemetry({
        success: true,
        latencyMs: winner.latencyMs,
        endpoint: winner.endpoint,
        method: winner.method,
      });

      return {
        success: true,
        hash: winner.hash,
        endpoint: winner.endpoint,
        latencyMs: winner.latencyMs,
        allAttempts: [],
      };
    } catch {
      // All endpoints failed — collect full diagnostics from settled results
      const allAttempts: (SubmissionResult | SubmissionError)[] = [];
      const results = await Promise.allSettled(
        this.endpoints.map(async (url) => {
          const client = this.clients.get(url);
          if (!client) return { endpoint: url, error: new Error("No pre-created client for endpoint"), latencyMs: 0 };
          const endpointStart = Date.now();
          try {
            const hash = (await client.request({
              method: "eth_sendRawTransaction",
              params: [serializedTx],
            })) as Hex;
            return { hash, endpoint: url, latencyMs: Date.now() - endpointStart, method: SUBMISSION_METHOD } as SubmissionResult;
          } catch (error) {
            return { endpoint: url, error, latencyMs: Date.now() - endpointStart } as SubmissionError;
          }
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled") allAttempts.push(result.value);
      }

      const failureReason = allAttempts
        .filter((r): r is SubmissionError => "error" in r)
        .map((r) => `${shortenUrl(r.endpoint)}: ${String(r.error)}`)
        .join("; ");

      recordTxSubmissionTelemetry({
        success: false,
        latencyMs: Date.now() - startTime,
        endpoint: "all",
        method: SUBMISSION_METHOD,
        error: failureReason,
      });

      return {
        success: false,
        error: `All ${this.endpoints.length} endpoints failed: ${failureReason}`,
        allAttempts,
      };
    }
  }

  /**
   * Submit to private mempool endpoints only (for MEV protection).
   * Falls back to public endpoints if no private endpoints configured.
   *
   * Uses pre-created clients for private endpoints (avoids creating
   * new viem clients per call unlike the old new-TransactionSniper approach).
   */
  async submitPrivate(serializedTx: Hex): Promise<SniperResult> {
    const targets = this.privateMempoolUrls.length > 0 ? this.privateMempoolUrls : this.endpoints;

    const clients = this.privateMempoolUrls.length > 0 ? this.privateClients : this.clients;

    const submissionPromises = targets.map(async (url) => {
      const client = clients.get(url);
      if (!client) {
        throw new Error("No pre-created client for endpoint");
      }
      const endpointStart = Date.now();
      const hash = (await client.request({
        method: "eth_sendRawTransaction",
        params: [serializedTx],
      })) as Hex;
      const latencyMs = Date.now() - endpointStart;
      logger.info({ hash, endpoint: shortenUrl(url), latencyMs }, "Transaction sniper: private submission successful");
      return { hash, endpoint: url, latencyMs, method: SUBMISSION_METHOD } as SubmissionResult;
    });

    try {
      const winner = await Promise.any(submissionPromises);
      recordTxSubmissionTelemetry({
        success: true,
        latencyMs: winner.latencyMs,
        endpoint: winner.endpoint,
        method: winner.method,
      });
      return {
        success: true,
        hash: winner.hash,
        endpoint: winner.endpoint,
        latencyMs: winner.latencyMs,
        allAttempts: [],
      };
    } catch {
      // All private endpoints failed, collect diagnostics
      const allAttempts: (SubmissionResult | SubmissionError)[] = [];
      const results = await Promise.allSettled(
        targets.map(async (url) => {
          const client = clients.get(url);
          if (!client) return { endpoint: url, error: new Error("No pre-created client"), latencyMs: 0 };
          const endpointStart = Date.now();
          try {
            const hash = (await client.request({
              method: "eth_sendRawTransaction",
              params: [serializedTx],
            })) as Hex;
            return { hash, endpoint: url, latencyMs: Date.now() - endpointStart, method: SUBMISSION_METHOD } as SubmissionResult;
          } catch (error) {
            return { endpoint: url, error, latencyMs: Date.now() - endpointStart } as SubmissionError;
          }
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled") allAttempts.push(r.value);
      }
      const failureReason = allAttempts
        .filter((r): r is SubmissionError => "error" in r)
        .map((r) => `${shortenUrl(r.endpoint)}: ${String(r.error)}`)
        .join("; ");
      return {
        success: false,
        error: `All ${targets.length} private endpoints failed: ${failureReason}`,
        allAttempts,
      };
    }
  }

  /**
   * Get the number of configured endpoints.
   */
  getEndpointCount(): number {
    return this.endpoints.length;
  }

  /**
   * Whether private mempool endpoints are configured.
   */
  get hasPrivateEndpoints(): boolean {
    return this.privateMempoolUrls.length > 0;
  }
}

// ─── Helper: Shorten URL for logging ───────────────────────────

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname.length > 20 ? u.pathname.slice(0, 20) + "..." : u.pathname);
  } catch {
    return url.slice(0, 40);
  }
}

// ─── Factory: Create sniper from config ────────────────────────

/**
 * Create a TransactionSniper from the bot's RPC configuration.
 * Includes public RPCs from config plus optional private mempool endpoints.
 */
export async function createSniperFromConfig(): Promise<TransactionSniper> {
  const { POLYGON_RPC } = await import("../config/index.ts");

  const endpoints: string[] = [];

  const execRpc = process.env.EXECUTION_RPC || POLYGON_RPC;
  if (execRpc) {
    endpoints.push(execRpc);
  }

  if (endpoints.length === 0) {
    endpoints.push("https://polygon-mainnet.g.alchemy.com/v2/demo", "https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com");
  }

  const uniqueEndpoints = [...new Set(endpoints)];

  const privateMempoolUrls: string[] = [];
  if (process.env.PRIVATE_MEMPOOL_URL) {
    privateMempoolUrls.push(process.env.PRIVATE_MEMPOOL_URL);
  }

  logger.info(
    {
      publicEndpoints: uniqueEndpoints.length,
      privateEndpoints: privateMempoolUrls.length,
    },
    "Transaction sniper initialized with multi-endpoint submission",
  );

  return new TransactionSniper(uniqueEndpoints, privateMempoolUrls);
}
