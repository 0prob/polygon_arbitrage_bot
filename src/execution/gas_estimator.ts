/**
 * gas_estimator.ts — Gas estimation via the dedicated GAS_ESTIMATION_RPC
 *
 * All eth_estimateGas / eth_call simulation calls route through the client
 * built from GAS_ESTIMATION_RPC_URL (see src/config/rpc_env.ts).
 *
 * This is intentionally a separate client from:
 *   - The main read/fallback pool (RpcManager) — no contamination of the
 *     general read path with simulation traffic.
 *   - The execution client — gas estimation ≠ broadcast.
 *
 * Typical call flow for an arb opportunity:
 *   1. simulateExecution()   – eth_call to check profitability + catch reverts
 *   2. estimateGas()         – eth_estimateGas with a buffer
 *   3. executor.submit()     – sendRawTransaction via EXECUTION_RPC (separate)
 */

import type { Address, Hex } from "viem";
import { createGasEstimationClient } from "../config/rpc_env.ts";
import { CONFIG_DEFAULT_GAS_BUFFER_BPS } from "../config/index.ts";

// ─── Singleton gas client ─────────────────────────────────────────────────────
// Created once; if the URL changes (e.g. in tests), call resetGasClient().

let _gasClient: ReturnType<typeof createGasEstimationClient> | null = null;

function getGasClient() {
  if (!_gasClient) _gasClient = createGasEstimationClient();
  return _gasClient;
}

/** Force re-creation of the gas client (useful in tests). */
export function resetGasClient(): void {
  _gasClient = null;
}

// ─── Gas estimate ─────────────────────────────────────────────────────────────

const GAS_BUFFER_BPS = CONFIG_DEFAULT_GAS_BUFFER_BPS;

/**
 * Estimate gas for a transaction via GAS_ESTIMATION_RPC.
 * Returns the raw estimate multiplied by GAS_BUFFER_BPS / 100.
 *
 * @throws if the call reverts (ethers-style: "execution reverted")
 */
export async function estimateGas(params: {
  to: Address;
  data: Hex;
  from: Address;
  value?: bigint;
}): Promise<bigint> {
  const client = getGasClient();
  const raw = await client.estimateGas({
    to:    params.to,
    data:  params.data,
    account: params.from,
    value: params.value ?? 0n,
  });
  return (raw * BigInt(GAS_BUFFER_BPS)) / 100n;
}

// ─── Pre-flight simulation ────────────────────────────────────────────────────

/**
 * Simulate a transaction (eth_call) via GAS_ESTIMATION_RPC and return the
 * raw bytes returned by the contract. Throws on revert.
 *
 * Use this to pre-flight arb execution before committing to gas costs.
 */
export async function simulateCall(params: {
  to: Address;
  data: Hex;
  from: Address;
  value?: bigint;
  blockTag?: "latest" | "pending";
}): Promise<Hex> {
  const client = getGasClient();
  return client.call({
    to:      params.to,
    data:    params.data,
    account: params.from,
    value:   params.value ?? 0n,
    blockTag: params.blockTag ?? "pending",
  }).then((r) => r.data ?? "0x");
}
