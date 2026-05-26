import type { Logger } from "../../infra/observability/logger.ts";
import type { GasOracle } from "./gas.ts";
import { scalePriorityFeeByProfitMargin } from "./gas.ts";
import type { NonceManager } from "./nonce.ts";
import { ExecutionTracker } from "./tracker.ts";
import { QuarantineManager } from "./quarantine.ts";
import { createPublicClient, http, getAddress, type PublicClient, decodeEventLog } from "viem";
import { getChain } from "../../infra/rpc/chains.ts";
import { SubmissionStrategy } from "../../config/schema.ts";
import type { FastLaneSubmitter } from "../../infra/rpc/fastlane.ts";

const ERC20_TRANSFER_EVENT = {
  anonymous: false,
  inputs: [
    { type: "address", name: "from", indexed: true },
    { type: "address", name: "to", indexed: true },
    { type: "uint256", name: "value", indexed: false },
  ],
  name: "Transfer",
  type: "event",
} as const;

function parseTransferLogs(logs: Array<{ topics: string[]; data: string }>, executor: `0x${string}`): bigint {
  let netProfit = 0n;
  for (const log of logs) {
    try {
      const parsed = decodeEventLog({
        abi: [ERC20_TRANSFER_EVENT],
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (parsed.args.to?.toLowerCase() === executor.toLowerCase()) {
        netProfit += parsed.args.value ?? 0n;
      }
    } catch {
      /* skip unmatched logs */
    }
  }
  return netProfit;
}

export interface CandidateExecution {
  routeKey: string;
  calldata: string;
  targetAddress: string;
  value: bigint;
  profitToken?: string;
  expectedProfit?: bigint;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: bigint;
}

export type SubmitTxFn = (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }) => Promise<string>;

export interface ExecutionServiceOptions {
  submissionStrategy?: SubmissionStrategy;
  privateSubmitter?: SubmitTxFn;
  fastLaneSubmitter?: FastLaneSubmitter;
  chainId?: number;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
  quarantineBaseMs?: number;
  quarantineMaxMs?: number;
}

function poolsFromRouteKey(routeKey: string): string[] {
  return routeKey.split(":").filter((p) => p.length === 42);
}

export function areCandidatesCompatible(a: CandidateExecution, b: CandidateExecution): boolean {
  const poolsA = new Set(poolsFromRouteKey(a.routeKey));
  const poolsB = poolsFromRouteKey(b.routeKey);
  return !poolsB.some((p) => poolsA.has(p));
}

export function groupCompatibleCandidates(candidates: CandidateExecution[]): CandidateExecution[][] {
  const groups: CandidateExecution[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < candidates.length; i++) {
    if (assigned.has(i)) continue;
    const group = [candidates[i]];
    assigned.add(i);
    const groupPools = new Set(poolsFromRouteKey(candidates[i].routeKey));

    for (let j = i + 1; j < candidates.length; j++) {
      if (assigned.has(j)) continue;
      const poolsJ = new Set(poolsFromRouteKey(candidates[j].routeKey));
      const disjoint = ![...poolsJ].some((p) => groupPools.has(p));
      if (disjoint) {
        group.push(candidates[j]);
        assigned.add(j);
        for (const p of poolsJ) groupPools.add(p);
      }
    }
    groups.push(group);
  }

  return groups;
}

export class ExecutionService {
  private quarantine: QuarantineManager;
  readonly tracker = new ExecutionTracker();
  private receiptClient: PublicClient | null = null;
  private readonly receiptTimeoutMs: number;
  private readonly receiptPollMs: number;
  private readonly submissionStrategy: SubmissionStrategy;
  private readonly privateSubmitter: SubmitTxFn | null;
  private readonly fastLaneSubmitter: FastLaneSubmitter | null;

  constructor(
    private logger: Logger,
    private gasOracle: GasOracle,
    private nonceManager: NonceManager,
    private submitters: SubmitTxFn[],
    options: ExecutionServiceOptions = {},
  ) {
    this.quarantine = new QuarantineManager(options.quarantineBaseMs, options.quarantineMaxMs);
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 30_000;
    this.receiptPollMs = (options as any).receiptPollMs ?? 500;
    this.submissionStrategy = options.submissionStrategy ?? "hybrid";
    this.privateSubmitter = options.privateSubmitter ?? null;
    this.fastLaneSubmitter = options.fastLaneSubmitter ?? null;

    if (options.chainId) {
      this.receiptClient = createPublicClient({
        chain: getChain(options.chainId),
        transport: http(),
      });
    }
  }

  getSubmissionStrategy(): SubmissionStrategy {
    return this.submissionStrategy;
  }

  async start(): Promise<void> {
    await this.gasOracle.start();
    await this.nonceManager.initialize();
    this.logger.info(
      { submissionStrategy: this.submissionStrategy, fastLaneEnabled: this.fastLaneSubmitter?.isEnabled() },
      "ExecutionService started",
    );
  }

  stop(): void {
    this.gasOracle.stop();
    this.logger.info({}, "ExecutionService stopped");
  }

  private async submitTx(
    tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint },
    expectedProfit?: bigint,
  ): Promise<{ txHash: string; endpoint: string }> {
    const snapshot = this.gasOracle.getSnapshot();
    let adjustedFee = tx.maxFee;
    let priorityFee = snapshot?.priorityFee ?? 1n * 10n ** 9n;
    if (expectedProfit && expectedProfit > 0n && snapshot) {
      const scaled = scalePriorityFeeByProfitMargin(snapshot.priorityFee, expectedProfit, this.gasOracle.config?.maxBidMultiplier ?? 3);
      adjustedFee = (this.gasOracle.getPredictedBaseFee() ?? snapshot.baseFee) * 2n + scaled;
      priorityFee = scaled;
    }

    const submit = async (fn: SubmitTxFn) => fn({ ...tx, maxFee: adjustedFee });

    if (this.fastLaneSubmitter?.isEnabled()) {
      try {
        const txHash = await this.fastLaneSubmitter.submitTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce: tx.nonce,
          maxFee: adjustedFee,
          priorityFee,
        });
        return { txHash, endpoint: "fastlane" };
      } catch (err) {
        this.logger.warn({ err }, "FastLane submission failed, falling back");
      }
    }

    if (this.submissionStrategy === "private" && this.privateSubmitter) {
      const txHash = await submit(this.privateSubmitter);
      return { txHash, endpoint: "private" };
    }

    if (this.submissionStrategy === "hybrid" && this.privateSubmitter) {
      try {
        const txHash = await Promise.race([
          submit(this.privateSubmitter).then((h) => ({ txHash: h, endpoint: "private" as const })),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("private timeout")), 2_000)),
        ]);
        if (txHash) return txHash;
      } catch {
        this.logger.debug({}, "Private submission failed, falling back to public");
      }
    }

    const txHash = await Promise.any(this.submitters.map((fn) => submit(fn)));
    return { txHash, endpoint: "public" };
  }

  async execute(candidate: CandidateExecution): Promise<ExecutionResult> {
    if (this.quarantine.isQuarantined(candidate.routeKey)) {
      const entry = this.quarantine.getEntry(candidate.routeKey);
      return { success: false, error: `route quarantined (backoff: attempt ${entry?.attempt ?? 0})` };
    }

    try {
      const fee = this.gasOracle.getSnapshot();
      if (!fee) {
        this.quarantine.add(candidate.routeKey, "no gas data");
        return { success: false, error: "no gas data" };
      }

      const nonce = this.nonceManager.getNextNonce();
      this.nonceManager.markInFlight(nonce);
      const { txHash, endpoint } = await this.submitTx(
        {
          to: candidate.targetAddress,
          data: candidate.calldata,
          value: candidate.value,
          nonce,
          maxFee: fee.maxFee,
        },
        candidate.expectedProfit,
      );

      this.nonceManager.confirmNonce(nonce);
      this.logger.info({ txHash, routeKey: candidate.routeKey, endpoint }, "Transaction submitted");

      const receipt = await this._waitForReceipt(txHash);
      const success = !!receipt?.status;
      const gasUsed = receipt?.gasUsed ?? 0n;

      let profit = 0n;
      if (success && receipt && candidate.profitToken) {
        const execAddr = getAddress(candidate.targetAddress);
        const logs = (receipt as any).logs ?? [];
        profit = parseTransferLogs(logs, execAddr);
      }

      this.tracker.record({
        routeKey: candidate.routeKey,
        txHash,
        success,
        gasUsed,
        profit,
        timestamp: Date.now(),
        pools: poolsFromRouteKey(candidate.routeKey),
        error: success ? undefined : "reverted",
      });

      if (!success && receipt) {
        this.logger.warn({ txHash, routeKey: candidate.routeKey }, "Transaction reverted");
        this.quarantine.add(candidate.routeKey, "reverted");
      } else if (success) {
        this.quarantine.recordSuccess(candidate.routeKey);
      }

      return { success, txHash, gasUsed };
    } catch (err: any) {
      if (err instanceof AggregateError) {
        const msg = err.errors[0]?.message || String(err);
        this.logger.warn({ routeKey: candidate.routeKey, error: msg }, "Transaction submission failed");
        this.quarantine.add(candidate.routeKey, msg);
        return { success: false, error: msg };
      }
      const msg = err?.message || String(err);
      this.logger.warn({ routeKey: candidate.routeKey, error: msg }, "Transaction submission failed");
      this.quarantine.add(candidate.routeKey, msg);
      return { success: false, error: msg };
    }
  }

  async batchExecute(candidates: CandidateExecution[]): Promise<ExecutionResult[]> {
    if (candidates.length === 0) return [];
    this.logger.info({ count: candidates.length }, "Batch executing candidates");

    const fee = this.gasOracle.getSnapshot();
    if (!fee) {
      return candidates.map(() => ({ success: false, error: "no gas data" }));
    }

    const results: ExecutionResult[] = new Array(candidates.length);
    const receiptPromises: { index: number; txHash: string; nonce: number; candidate: CandidateExecution }[] = [];

    // Phase 1: Sequential Submission
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (this.quarantine.isQuarantined(candidate.routeKey)) {
        results[i] = { success: false, error: "route quarantined" };
        continue;
      }

      const nonce = this.nonceManager.getNextNonce();
      this.nonceManager.markInFlight(nonce);

      try {
        const { txHash, endpoint } = await this.submitTx(
          {
            to: candidate.targetAddress,
            data: candidate.calldata,
            value: candidate.value,
            nonce,
            maxFee: fee.maxFee,
          },
          candidate.expectedProfit,
        );

        this.nonceManager.confirmNonce(nonce);
        this.logger.info({ txHash, routeKey: candidate.routeKey, endpoint }, "Batch tx submitted");
        receiptPromises.push({ index: i, txHash, nonce, candidate });
      } catch (err: any) {
        const msg = err?.message || String(err);
        this.logger.warn({ routeKey: candidate.routeKey, error: msg, nonce }, "Batch submission failed");
        this.quarantine.add(candidate.routeKey, msg);
        results[i] = { success: false, error: msg };
        // We continue to the next one, but since this one failed, the next nonces might also fail
        // if this was a nonce-related error. However, NonceManager will give us the same nonce next time
        // if we didn't confirm it? No, getNextNonce increments.
        // If it failed to submit, we should probably mark the nonce as stale or revert the nonce manager?
        // NonceManager usually tracks the next expected nonce.
        // If submission fails, we didn't use the nonce.
      }
    }

    // Phase 2: Parallel Receipt Waiting
    await Promise.all(
      receiptPromises.map(async ({ index, txHash, nonce, candidate }) => {
        try {
          const receipt = await this._waitForReceipt(txHash);
          if (!receipt) {
            this.nonceManager.markStale(nonce);
            this.logger.warn({ txHash, routeKey: candidate.routeKey }, "No receipt received within timeout — marking nonce stale");
            results[index] = { success: false, txHash, error: "timeout" };
            return;
          }

          const success = !!receipt.status;
          const gasUsed = receipt.gasUsed;

          let profit = 0n;
          if (success && candidate.profitToken) {
            const execAddr = getAddress(candidate.targetAddress);
            const logs = receipt.logs;
            profit = parseTransferLogs(logs, execAddr);
          }

          this.tracker.record({
            routeKey: candidate.routeKey,
            txHash,
            success,
            gasUsed,
            profit,
            timestamp: Date.now(),
            pools: poolsFromRouteKey(candidate.routeKey),
            error: success ? undefined : "reverted",
          });

          if (!success) {
            this.logger.warn({ txHash, routeKey: candidate.routeKey }, "Batch tx reverted");
            this.quarantine.add(candidate.routeKey, "reverted");
          } else {
            this.quarantine.recordSuccess(candidate.routeKey);
          }

          results[index] = { success, txHash, gasUsed };
        } catch (err: any) {
          const msg = err?.message || String(err);
          this.logger.error({ txHash, error: msg }, "Error waiting for batch receipt");
          results[index] = { success: false, txHash, error: msg };
        }
      }),
    );

    // Fill in any remaining gaps (though there shouldn't be any)
    for (let i = 0; i < results.length; i++) {
      if (!results[i]) results[i] = { success: false, error: "unknown error" };
    }

    return results;
  }

  private async _waitForReceipt(
    txHash: string,
  ): Promise<{ status: boolean; gasUsed: bigint; logs: Array<{ topics: string[]; data: string }> } | null> {
    if (!this.receiptClient) return null;
    const deadline = Date.now() + this.receiptTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const receipt = await this.receiptClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
        if (receipt) {
          return { status: receipt.status === "success", gasUsed: receipt.gasUsed, logs: (receipt as any).logs ?? [] };
        }
      } catch {
        // Receipt not yet available
      }
      await new Promise((r) => setTimeout(r, this.receiptPollMs));
    }
    return null;
  }

  isQuarantined(routeKey: string): boolean {
    return this.quarantine.isQuarantined(routeKey);
  }

  getQuarantineManager(): QuarantineManager {
    return this.quarantine;
  }
}
