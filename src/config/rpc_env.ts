import { type PublicClient, type WalletClient, type Account } from "viem";
import {
  createReadClient,
  createExecutionClient as createExec,
  createGasEstimationClient as createGas,
} from "../infra/rpc/client_factory.ts";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[rpc_env] FATAL: required env var ${key} is not set.`);
    return `__missing_${key}__`;
  }
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const POLYGON_RPC_URL: string = requireEnv("POLYGON_RPC");

export const POLYGON_RPC_URLS: string[] = (process.env.POLYGON_RPC_URLS ?? POLYGON_RPC_URL)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

export const GAS_ESTIMATION_RPC_URL: string = optionalEnv("GAS_ESTIMATION_RPC", POLYGON_RPC_URL);
export const EXECUTION_RPC_URL: string = optionalEnv("EXECUTION_RPC", POLYGON_RPC_URL);

let _gasEstimationClient: PublicClient | null = null;
let _executionReadClient: PublicClient | null = null;
let _executionWalletClient: WalletClient | null = null;
let _primaryReadClient: PublicClient | null = null;

export function getPrimaryReadClient(): PublicClient {
  if (_primaryReadClient) return _primaryReadClient;
  _primaryReadClient = createReadClient(POLYGON_RPC_URLS, { chainId: 137 });
  return _primaryReadClient;
}

export function createGasEstimationClient(): PublicClient {
  if (_gasEstimationClient) return _gasEstimationClient;
  _gasEstimationClient = createGas(GAS_ESTIMATION_RPC_URL, 137);
  return _gasEstimationClient;
}

export function createExecutionClient(account?: Account): WalletClient {
  if (_executionWalletClient) return _executionWalletClient;
  if (!account) throw new Error("createExecutionClient: account is required for initialization");

  _executionWalletClient = createExec(EXECUTION_RPC_URL, (account as any).address, 137);
  // Re-inject account if needed by the caller, though factory should handle it if pk passed
  return _executionWalletClient;
}

export function createExecutionReadClient(): PublicClient {
  if (_executionReadClient) return _executionReadClient;
  _executionReadClient = createReadClient([EXECUTION_RPC_URL], { chainId: 137, timeoutMs: 10_000 });
  return _executionReadClient;
}

export function resetRpcClients() {
  _gasEstimationClient = null;
  _executionReadClient = null;
  _executionWalletClient = null;
  _primaryReadClient = null;
}
