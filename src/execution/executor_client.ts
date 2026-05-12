/**
 * executor_client.ts — Transaction submission via the dedicated EXECUTION_RPC
 *
 * IMPORTANT: The execution client has NO fallback rotation.
 *
 * Rationale: In a MEV / arbitrage context, silently re-submitting through a
 * slower or public fallback node is dangerous:
 *   - The tx may land on-chain via the fallback after a non-atomic delay,
 *     at a worse gas price / block position.
 *   - Duplicate nonce submissions cause one to revert on-chain (wasted gas).
 *   - Public RPCs may broadcast to a wider mempool, losing front-run protection.
 *
 * If EXECUTION_RPC is unavailable, this module throws — the caller (typically
 * the arb engine) should log and skip that opportunity.
 *
 * Usage:
 *   import { ExecutorClient } from "./executor_client.js";
 *   const exec = new ExecutorClient(privateKeyToAccount(PRIVATE_KEY));
 *   const hash = await exec.submit(signedTx);
 *   const receipt = await exec.waitForReceipt(hash);
 */

import {
  createExecutionClient,
  createExecutionReadClient,
} from "../config/rpc_env.ts";
import type { Account, Hex, TransactionReceipt } from "viem";

export class ExecutorClient {
  private readonly wallet: ReturnType<typeof createExecutionClient>;
  private readonly reader: ReturnType<typeof createExecutionReadClient>;

  constructor(account: Account) {
    this.wallet = createExecutionClient(account);
    this.reader = createExecutionReadClient();
  }

  /**
   * Broadcast a pre-signed raw transaction via EXECUTION_RPC.
   * No retry, no fallback — throws on network error or node rejection.
   *
   * @param serializedTx  Hex-encoded signed transaction (e.g. from signTransaction).
   * @returns             Transaction hash.
   */
  async submit(serializedTx: Hex): Promise<Hex> {
    return this.wallet.sendRawTransaction({ serializedTransaction: serializedTx });
  }

  /**
   * Send a transaction (the wallet client signs + submits atomically).
   * Use `submit()` instead if you need explicit control over the signed bytes
   * (e.g. for private mempool / bundle submission).
   */
  async sendTransaction(
    params: Parameters<typeof this.wallet.sendTransaction>[0],
  ): Promise<Hex> {
    return this.wallet.sendTransaction(params);
  }

  /**
   * Poll for a transaction receipt on the EXECUTION_RPC endpoint.
   * Uses the read client on the same URL so the receipt resolves as soon as
   * the execution node has seen the inclusion.
   *
   * @param hash             Transaction hash to wait for.
   * @param confirmations    Blocks to wait for (default 1).
   * @param timeoutMs        Max wait time in milliseconds (default 60s).
   */
  async waitForReceipt(
    hash: Hex,
    confirmations = 1,
    timeoutMs = 60_000,
  ): Promise<TransactionReceipt> {
    return this.reader.waitForTransactionReceipt({
      hash,
      confirmations,
      timeout: timeoutMs,
    });
  }

  /**
   * Estimate gas for a transaction via the EXECUTION_RPC.
   *
   * NOTE: For pre-flight simulation prefer gas_estimator.ts which uses
   * GAS_ESTIMATION_RPC (simulation-quality endpoint). This method is provided
   * for cases where you need an estimate anchored to the same node that will
   * broadcast the tx (useful for nonce-critical timing).
   */
  async estimateGas(
    params: Parameters<typeof this.reader.estimateGas>[0],
  ): Promise<bigint> {
    return this.reader.estimateGas(params);
  }
}
