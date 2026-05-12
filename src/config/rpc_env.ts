/**
 * rpc_env.ts — RPC endpoint configuration
 *
 * Three logically separate RPC roles, each independently configurable:
 *
 *   POLYGON_RPC          – general read traffic + subscriptions, backed by a
 *                          fallback pool (RpcManager). Never used for gas
 *                          estimation or tx submission.
 *
 *   GAS_ESTIMATION_RPC   – dedicated endpoint for eth_estimateGas / eth_call
 *                          pre-flight simulations. Defaults to POLYGON_RPC.
 *                          Intentionally NOT in the fallback pool.
 *
 *   EXECUTION_RPC        – dedicated endpoint for sendRawTransaction (live
 *                          trade submission). Defaults to POLYGON_RPC.
 *                          Intentionally NOT in the fallback pool — if this
 *                          endpoint is unavailable, execution halts rather
 *                          than silently routing through a slower public node.
 */

import { createPublicClient, createWalletClient, http } from "viem";
import { polygon } from "viem/chains";

// ─── Raw URL helpers ──────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    // Defer to a runtime error with a clear message rather than crashing at
    // module-load time (which produces a cryptic "Cannot read properties of
    // undefined" stack trace before any logging is initialized).
    console.error(
      `[rpc_env] FATAL: required env var ${key} is not set. ` +
      `Set it in your .env file before starting.`
    );
    // Return a placeholder that will produce a clear fetch error if used,
    // rather than silently substituting a demo endpoint.
    return `__missing_${key}__`;
  }
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// ─── Primary RPC (read / subscriptions / fallback pool) ───────────────────────

export const POLYGON_RPC_URL: string = requireEnv("POLYGON_RPC");

/**
 * Comma-separated fallback RPC pool. Tenderly (simulation-only) endpoints
 * must NOT appear here — they belong in GAS_ESTIMATION_RPC.
 */
export const POLYGON_RPC_URLS: string[] = (
  process.env.POLYGON_RPC_URLS ?? POLYGON_RPC_URL
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

// ─── Gas estimation RPC (eth_estimateGas / eth_call) ─────────────────────────

/**
 * Dedicated URL for gas estimation. Defaults to POLYGON_RPC.
 * Use a simulation-quality endpoint (Tenderly fork/node, Alchemy Simulation,
 * or any full-node with accurate pending-state support).
 * This URL is NEVER added to the fallback pool.
 */
export const GAS_ESTIMATION_RPC_URL: string = optionalEnv(
  "GAS_ESTIMATION_RPC",
  POLYGON_RPC_URL
);

// ─── Execution RPC (sendRawTransaction) ──────────────────────────────────────

/**
 * Dedicated URL for live transaction submission. Defaults to POLYGON_RPC.
 * Use a low-latency private endpoint. This URL is NEVER added to the fallback
 * pool — a missing or failing execution RPC is treated as a hard error, not
 * silently retried through public nodes.
 */
export const EXECUTION_RPC_URL: string = optionalEnv(
  "EXECUTION_RPC",
  POLYGON_RPC_URL
);

// ─── Viem clients ─────────────────────────────────────────────────────────────

// Singleton clients — created once, reused across the process lifecycle.
// Creating a new viem client per call allocates new HTTP agents, connection
// pools, and internal state. For the gas estimation and execution RPCs that
// are called frequently, this overhead is significant.
let _gasEstimationClient: ReturnType<typeof createPublicClient> | null = null;
let _executionReadClient: ReturnType<typeof createPublicClient> | null = null;
let _executionWalletClient: ReturnType<typeof createWalletClient> | null = null;

/**
 * Client exclusively for gas estimation (eth_estimateGas, eth_call).
 * Routed to GAS_ESTIMATION_RPC_URL; no fallback rotation.
 * Singleton — reused across all calls.
 */
export function createGasEstimationClient() {
  if (_gasEstimationClient) return _gasEstimationClient;
  _gasEstimationClient = createPublicClient({
    chain: polygon,
    transport: http(GAS_ESTIMATION_RPC_URL, {
      // Tight timeout — if the simulation RPC is slow, fail fast and skip the
      // opportunity rather than holding up the hot path.
      timeout: 5_000,
    }),
    batch: { multicall: true },
  });
  return _gasEstimationClient;
}

/**
 * Wallet client exclusively for submitting signed transactions.
 * Routed to EXECUTION_RPC_URL; no fallback rotation.
 * Singleton — reused across all calls.
 */
export function createExecutionClient(account: Parameters<typeof createWalletClient>[0]["account"]) {
  if (_executionWalletClient) {
    if (account == null) return _executionWalletClient;
    return _executionWalletClient;
  }
  if (account == null) {
    throw new Error("createExecutionClient: account parameter is required for first initialization");
  }
  _executionWalletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(EXECUTION_RPC_URL, {
      timeout: 10_000,
      retryCount: 0,
    }),
  });
  return _executionWalletClient;
}

/**
 * Public client on the execution RPC, used for receipt polling after
 * sendRawTransaction. Same endpoint as execution so receipts resolve quickly.
 * Singleton — reused across all calls.
 */
export function createExecutionReadClient() {
  if (_executionReadClient) return _executionReadClient;
  _executionReadClient = createPublicClient({
    chain: polygon,
    transport: http(EXECUTION_RPC_URL, {
      timeout: 10_000,
      retryCount: 0,
    }),
    batch: { multicall: true },
  });
  return _executionReadClient;
}

/** Reset all singleton clients (useful for testing or RPC failover). */
export function resetRpcClients() {
  _gasEstimationClient = null;
  _executionReadClient = null;
  _executionWalletClient = null;
}
