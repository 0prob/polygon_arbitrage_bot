/**
 * src/execution/private_tx.js — Polygon private mempool transaction submitter
 *
 * Optimized for HFT:
 *   - Implements parallel submission racing across all configured private relays.
 *   - Minimizes inclusion latency by firing to all endpoints simultaneously.
 */

import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FREE_RPC_URLS,
  PRIVATE_MEMPOOL_URL,
  PRIVATE_MEMPOOL_METHOD,
  POLYGON_PRIVATE_MEMPOOL_URL,
  POLYGON_PRIVATE_MEMPOOL_METHOD,
  POLYGON_PRIVATE_MEMPOOL_AUTH_HEADER,
  POLYGON_PRIVATE_MEMPOOL_AUTH_TOKEN,
  CONFIG_JSON_RPC_TIMEOUT_MS,
} from "../config/index.ts";

// ─── Constants ────────────────────────────────────────────────

const FAST_PUBLIC_RPCS = [...FREE_RPC_URLS];

const DEFAULT_JSON_RPC_TIMEOUT_MS = CONFIG_JSON_RPC_TIMEOUT_MS;
const MAX_ERROR_BODY_CHARS = 300;

export type RawTransaction = string;
type RpcUrl = string;
type JsonRpcHeaders = Record<string, string>;
type JsonRpcOptions = {
  timeoutMs?: number;
};
type JsonRpcErrorPayload = {
  code?: string | number;
  message?: string;
  [key: string]: unknown;
};
type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorPayload;
};
export type SignableTransaction = {
  to: string;
  data: string;
  value?: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
};
type PrivateTxOptions = {
  allowPublicFallback?: boolean;
  publicRpcs?: string[];
  requestTimeoutMs?: number;
};
type BundleOptions = JsonRpcOptions & {
  blockNumber?: bigint | number;
  minTimestamp?: number;
  maxTimestamp?: number;
};
export type SubmissionResult = {
  submitted: boolean;
  txHash?: string;
  bundleHash?: unknown;
  method?: string;
  retryIndividually?: boolean;
  error?: string;
};

// ─── Low-level JSON-RPC helper ────────────────────────────────

/**
 * Send a raw JSON-RPC request to a URL.
 */
export async function jsonRpc(
  url: RpcUrl,
  method: string,
  params: unknown[],
  headers: JsonRpcHeaders = {},
  options: JsonRpcOptions = {},
): Promise<JsonRpcResponse> {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? DEFAULT_JSON_RPC_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  let res;
  let text = "";
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err: unknown) {
    const error = err as { name?: unknown; message?: unknown } | null | undefined;
    const reason = error?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (error?.message ?? String(err));
    throw new Error(`JSON-RPC ${method} to ${rpcManagerShortUrl(url)} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`JSON-RPC ${method} to ${rpcManagerShortUrl(url)} failed: HTTP ${res.status}: ${summarizeBody(text)}`);
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`JSON-RPC ${method} to ${rpcManagerShortUrl(url)} returned invalid JSON: ${summarizeBody(text)}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error(`JSON-RPC ${method} to ${rpcManagerShortUrl(url)} returned empty or invalid response`);
  }

  if (payload.error) {
    const code = payload.error.code != null ? `${payload.error.code}: ` : "";
    const message = payload.error.message ?? JSON.stringify(payload.error);
    throw new Error(`JSON-RPC ${method} to ${rpcManagerShortUrl(url)} failed: ${code}${message}`);
  }

  return payload;
}

function summarizeBody(value: string) {
  const compact = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.slice(0, MAX_ERROR_BODY_CHARS) || "<empty response>";
}

function rpcManagerShortUrl(url: unknown) {
  try {
    const u = new URL(String(url));
    return u.hostname + (u.pathname !== "/" ? u.pathname.slice(0, 40) : "");
  } catch {
    return String(url || "").slice(0, 80);
  }
}

function summarizeSubmissionFailure(error: unknown) {
  if (error instanceof AggregateError) {
    return error.errors
      .map((err: unknown) => (err as { message?: unknown } | null | undefined)?.message ?? String(err))
      .filter(Boolean)
      .join(" | ");
  }
  return String((error as { message?: unknown } | null | undefined)?.message ?? error);
}

function requireRpcResultString(response: JsonRpcResponse, label: string) {
  if (response.result == null) {
    throw new Error(`${label}: missing JSON-RPC result`);
  }
  return String(response.result);
}

function isAlreadyKnownSubmission(error: unknown) {
  const err = error as { shortMessage?: unknown; message?: unknown } | null | undefined;
  const message = String(err?.shortMessage ?? err?.message ?? error ?? "").toLowerCase();
  return message.includes("already known") || message.includes("already imported") || message.includes("known transaction");
}

function submittedRawTxHash(rawTx: RawTransaction) {
  return keccak256(String(rawTx) as `0x${string}`);
}

function polygonPrivateMempoolHeaders() {
  if (!POLYGON_PRIVATE_MEMPOOL_AUTH_HEADER || !POLYGON_PRIVATE_MEMPOOL_AUTH_TOKEN) {
    return {};
  }
  return {
    [POLYGON_PRIVATE_MEMPOOL_AUTH_HEADER]: POLYGON_PRIVATE_MEMPOOL_AUTH_TOKEN,
  };
}

// ─── Sign transaction ─────────────────────────────────────────

/**
 * Sign a transaction locally without any RPC round-trip.
 *
 * Fix: the previous implementation called walletClient.prepareTransactionRequest()
 * which fetches the current nonce and fee data from the chain — an unnecessary
 * network call when the caller already supplies nonce, gasLimit, maxFeePerGas,
 * and maxPriorityFeePerGas (as buildArbTx always does). This competed with hot-path
 * reads and could override NonceManager's locally-tracked nonce with a stale on-chain
 * value when transactions are in-flight in the mempool.
 *
 * We now call account.signTransaction() directly with a fully-specified request,
 * which is a pure CPU operation with no network I/O.
 */
export async function signTransaction(tx: SignableTransaction, privateKey: string, nonce?: bigint | number | null, chainId = 137) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  if (nonce == null) {
    // Nonce not provided — must fetch from chain. Use executionClient (dedicated
    // endpoint) rather than creating a throwaway walletClient per call.
    const { executionClient } = await import("./gas.ts");
    const onchainNonce = await executionClient.getTransactionCount({
      address: account.address as `0x${string}`,
      blockTag: "pending",
    });
    nonce = Number(onchainNonce);
  }

  // Build the full EIP-1559 transaction object and sign it locally — no RPC.
  const request = {
    to: tx.to as `0x${string}`,
    data: tx.data as `0x${string}`,
    value: tx.value ?? 0n,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    gas: tx.gasLimit,
    nonce: Number(nonce),
    chainId,
    type: "eip1559" as const,
  };

  return account.signTransaction(request);
}

// ─── Submission strategies ────────────────────────────────────

export async function sendPrivateTransaction(rawTx: RawTransaction, rpcUrl?: string | null, options: JsonRpcOptions = {}) {
  const url = rpcUrl || PRIVATE_MEMPOOL_URL;
  if (!url) throw new Error("sendPrivateTransaction: no URL");

  let response: JsonRpcResponse;
  try {
    response = await jsonRpc(url, "eth_sendPrivateTransaction", [{ tx: rawTx }], {}, { timeoutMs: options.timeoutMs });
  } catch (err) {
    if (isAlreadyKnownSubmission(err)) return submittedRawTxHash(rawTx);
    throw err;
  }
  return requireRpcResultString(response, "sendPrivateTransaction");
}

export async function sendPolygonPrivateTransaction(rawTx: RawTransaction, rpcUrl?: string | null, options: JsonRpcOptions = {}) {
  const url = rpcUrl || POLYGON_PRIVATE_MEMPOOL_URL;
  if (!url) throw new Error("sendPolygonPrivateTransaction: no URL");

  const method = POLYGON_PRIVATE_MEMPOOL_METHOD || "eth_sendRawTransaction";
  const params = method === "eth_sendPrivateTransaction" ? [{ tx: rawTx }] : [rawTx];

  let response: JsonRpcResponse;
  try {
    response = await jsonRpc(url, method, params, polygonPrivateMempoolHeaders(), { timeoutMs: options.timeoutMs });
  } catch (err) {
    if (isAlreadyKnownSubmission(err)) return submittedRawTxHash(rawTx);
    throw err;
  }
  return requireRpcResultString(response, "sendPolygonPrivateTransaction");
}

/**
 * Submit a bundle of transactions to Alchemy (Flashbots-compatible).
 */
export async function sendBundleAlchemy(rawTxs: RawTransaction[], options: BundleOptions = {}, rpcUrl?: string | null) {
  const url = rpcUrl || PRIVATE_MEMPOOL_URL;
  if (!url) throw new Error("sendBundleAlchemy: no URL");
  if (options.blockNumber == null) throw new Error("sendBundleAlchemy: blockNumber required");

  const blockNumber = BigInt(options.blockNumber);
  const response = await jsonRpc(
    url,
    "eth_sendBundle",
    [
      {
        txs: rawTxs,
        blockNumber: `0x${blockNumber.toString(16)}`,
        minTimestamp: options.minTimestamp,
        maxTimestamp: options.maxTimestamp,
      },
    ],
    {},
    { timeoutMs: options.timeoutMs },
  );

  return requireRpcResultString(response, "sendBundleAlchemy");
}

function privateMempoolSupportsBundles() {
  return Boolean(PRIVATE_MEMPOOL_URL && PRIVATE_MEMPOOL_METHOD === "eth_sendBundle");
}

export async function sendPrivateBundle(rawTxs: RawTransaction[], options: BundleOptions = {}): Promise<SubmissionResult> {
  const { blockNumber } = options;
  if (!blockNumber) throw new Error("sendPrivateBundle: blockNumber required");

  const submissions: Array<Promise<{ bundleHash: unknown; method: string }>> = [];

  if (privateMempoolSupportsBundles()) {
    submissions.push(
      sendBundleAlchemy(rawTxs, { ...options, blockNumber }, PRIVATE_MEMPOOL_URL).then((bundleHash) => ({
        bundleHash,
        method: "eth_sendBundle",
      })),
    );
  }

  if (submissions.length === 0) {
    return {
      submitted: false,
      retryIndividually: true,
      error: "No bundle-capable relay configured",
    };
  }

  try {
    const result = await Promise.any(submissions);
    console.log(`[private_tx] Private bundle submitted via ${result.method}`);
    return { submitted: true, ...result };
  } catch (err: unknown) {
    return { submitted: false, error: summarizeSubmissionFailure(err) };
  }
}

export async function racePublicRPCs(rawTx: RawTransaction, rpcs?: string[] | null, options: JsonRpcOptions = {}) {
  const targets = rpcs && rpcs.length > 0 ? rpcs : FAST_PUBLIC_RPCS;

  const submissions = targets.map(async (url: string) => {
    let response: JsonRpcResponse;
    try {
      response = await jsonRpc(url, "eth_sendRawTransaction", [rawTx], {}, { timeoutMs: options.timeoutMs });
    } catch (err) {
      if (isAlreadyKnownSubmission(err)) return submittedRawTxHash(rawTx);
      throw err;
    }
    return requireRpcResultString(response, "racePublicRPCs");
  });

  return Promise.any(submissions);
}

// ─── Main private TX sender (Optimized) ────────────────────────

/**
 * Submit a signed transaction via parallel racing across all private relays.
 *
 * Instead of sequential attempts, we fire to all configured endpoints
 * simultaneously. This ensures the fastest relay wins and minimizes latency.
 */
export async function sendPrivateTx(rawTx: RawTransaction, options: PrivateTxOptions = {}): Promise<SubmissionResult> {
  const { allowPublicFallback = true, publicRpcs = undefined, requestTimeoutMs = DEFAULT_JSON_RPC_TIMEOUT_MS } = options;
  const submissions: Array<Promise<{ txHash: string; method: string }>> = [];

  // 1. Dedicated Polygon private mempool
  if (POLYGON_PRIVATE_MEMPOOL_URL) {
    submissions.push(
      sendPolygonPrivateTransaction(rawTx, POLYGON_PRIVATE_MEMPOOL_URL, { timeoutMs: requestTimeoutMs }).then((txHash) => ({
        txHash,
        method: `polygon_private_mempool:${POLYGON_PRIVATE_MEMPOOL_METHOD}`,
      })),
    );
  }

  // 2. eth_sendPrivateTransaction (Alchemy/QuickNode)
  if (PRIVATE_MEMPOOL_URL && PRIVATE_MEMPOOL_METHOD === "eth_sendPrivateTransaction") {
    submissions.push(
      sendPrivateTransaction(rawTx, PRIVATE_MEMPOOL_URL, { timeoutMs: requestTimeoutMs }).then((txHash) => ({
        txHash,
        method: "eth_sendPrivateTransaction",
      })),
    );
  }

  // 3. eth_sendRawTransaction to private endpoint
  if (PRIVATE_MEMPOOL_URL && (!PRIVATE_MEMPOOL_METHOD || PRIVATE_MEMPOOL_METHOD === "eth_sendRawTransaction")) {
    submissions.push(
      jsonRpc(PRIVATE_MEMPOOL_URL, "eth_sendRawTransaction", [rawTx], {}, { timeoutMs: requestTimeoutMs })
        .then((res: JsonRpcResponse) => {
          return { txHash: requireRpcResultString(res, "eth_sendRawTransaction_private"), method: "eth_sendRawTransaction_private" };
        })
        .catch((err: unknown) => {
          if (isAlreadyKnownSubmission(err)) {
            return { txHash: submittedRawTxHash(rawTx), method: "eth_sendRawTransaction_private_known" };
          }
          throw err;
        }),
    );
  }

  // Fire all private submissions in parallel
  if (submissions.length > 0) {
    try {
      const result = await Promise.any(submissions);
      console.log(`[private_tx] Raced private submission success: ${result.txHash} via ${result.method}`);
      return { submitted: true, ...result };
    } catch (err: unknown) {
      console.warn(`[private_tx] All parallel private submissions failed: ${summarizeSubmissionFailure(err)}`);
    }
  }

  // 4. Public RPC race (fallback)
  if (allowPublicFallback) {
    console.warn("[private_tx] Falling back to public RPC race");
    try {
      const txHash = await racePublicRPCs(rawTx, publicRpcs, { timeoutMs: requestTimeoutMs });
      return { submitted: true, txHash, method: "public_race" };
    } catch (err: unknown) {
      return { submitted: false, error: `Public race failed: ${summarizeSubmissionFailure(err)}` };
    }
  }

  return { submitted: false, error: "No submission methods succeeded" };
}
