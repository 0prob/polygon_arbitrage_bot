import type { Logger } from "../../infra/observability/logger.ts";
import type { GasOracle } from "./gas.ts";
import type { NonceManager } from "./nonce.ts";
import { ExecutionTracker } from "./tracker.ts";
import { createPublicClient, http, type PublicClient } from "viem";
import { getChain } from "../../infra/rpc/chains.ts";
import { SubmissionStrategy } from "../../config/schema.ts";

export interface CandidateExecution {
  routeKey: string;
  calldata: string;
  targetAddress: string;
  value: bigint;
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
  chainId?: number;
  receiptTimeoutMs?: number;
}

function poolsFromRouteKey(routeKey: string): string[] {
  return routeKey.split(":").filter(p => p.length === 42);
}

export function areCandidatesCompatible(a: CandidateExecution, b: CandidateExecution): boolean {
  const poolsA = new Set(poolsFromRouteKey(a.routeKey));
  const poolsB = poolsFromRouteKey(b.routeKey);
  return !poolsB.some(p => poolsA.has(p));
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
      const disjoint = ![...poolsJ].some(p => groupPools.has(p));
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
  private quarantine = new Set<string>();
  private readonly MAX_QUARANTINE = 10_000;
  private _quarantineQueue: string[] = [];
  readonly tracker = new ExecutionTracker();
  private receiptClient: PublicClient | null = null;
  private readonly receiptTimeoutMs: number;
  private readonly submissionStrategy: SubmissionStrategy;
  private readonly privateSubmitter: SubmitTxFn | null;

  constructor(
    private logger: Logger,
    private gasOracle: GasOracle,
    private nonceManager: NonceManager,
    private submitters: SubmitTxFn[],
    options: ExecutionServiceOptions = {},
  ) {
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? 30_000;
    this.submissionStrategy = options.submissionStrategy ?? "hybrid";
    this.privateSubmitter = options.privateSubmitter ?? null;

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
    this.logger.info({ submissionStrategy: this.submissionStrategy }, "ExecutionService started");
  }

  stop(): void {
    this.gasOracle.stop();
    this.logger.info({}, "ExecutionService stopped");
  }

  private async submitTx(tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }): Promise<{ txHash: string; endpoint: string }> {
    if (this.submissionStrategy === "private" && this.privateSubmitter) {
      const txHash = await this.privateSubmitter(tx);
      return { txHash, endpoint: "private" };
    }

    if (this.submissionStrategy === "hybrid" && this.privateSubmitter) {
      try {
        const txHash = await Promise.race([
          this.privateSubmitter(tx).then(h => ({ txHash: h, endpoint: "private" as const })),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("private timeout")), 2_000)),
        ]);
        if (txHash) return txHash;
      } catch {
        this.logger.debug({}, "Private submission failed, falling back to public");
      }
    }

    const txHash = await Promise.any(
      this.submitters.map(submit => submit(tx))
    );
    return { txHash, endpoint: "public" };
  }

  async execute(candidate: CandidateExecution): Promise<ExecutionResult> {
    if (this.quarantine.has(candidate.routeKey)) {
      return { success: false, error: "route quarantined" };
    }

    try {
      const fee = this.gasOracle.getSnapshot();
      if (!fee) {
        this._addQuarantine(candidate.routeKey);
        return { success: false, error: "no gas data" };
      }

      const nonce = this.nonceManager.getNextNonce();
      const { txHash, endpoint } = await this.submitTx({
        to: candidate.targetAddress,
        data: candidate.calldata,
        value: candidate.value,
        nonce,
        maxFee: fee.maxFee,
      });

      this.nonceManager.confirmNonce(nonce).catch(() => {});
      this.logger.info({ txHash, routeKey: candidate.routeKey, endpoint }, "Transaction submitted");

      const receipt = await this._waitForReceipt(txHash);
      const success = !!receipt?.status;
      const gasUsed = receipt?.gasUsed ?? 0n;

      this.tracker.record({
        routeKey: candidate.routeKey,
        txHash,
        success,
        gasUsed,
        profit: 0n,
        timestamp: Date.now(),
        pools: poolsFromRouteKey(candidate.routeKey),
        error: success ? undefined : "reverted",
      });

      if (!success && receipt) {
        this.logger.warn({ txHash, routeKey: candidate.routeKey }, "Transaction reverted");
        this._addQuarantine(candidate.routeKey);
      } else if (success) {
        this.quarantine.delete(candidate.routeKey);
      }

      return { success, txHash, gasUsed };
    } catch (err: any) {
      if (err instanceof AggregateError) {
        const msg = err.errors[0]?.message || String(err);
        this.logger.warn({ routeKey: candidate.routeKey, error: msg }, "Transaction submission failed");
        this._addQuarantine(candidate.routeKey);
        return { success: false, error: msg };
      }
      const msg = err?.message || String(err);
      this.logger.warn({ routeKey: candidate.routeKey, error: msg }, "Transaction submission failed");
      this._addQuarantine(candidate.routeKey);
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
    const pending: { index: number; promise: Promise<ExecutionResult> }[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (this.quarantine.has(candidate.routeKey)) {
        results[i] = { success: false, error: "route quarantined" };
        continue;
      }

      const nonce = this.nonceManager.getNextNonce();
      const promise = (async () => {
        try {
          const { txHash, endpoint } = await this.submitTx({
            to: candidate.targetAddress,
            data: candidate.calldata,
            value: candidate.value,
            nonce,
            maxFee: fee.maxFee,
          });
          this.nonceManager.confirmNonce(nonce).catch(() => {});
          this.logger.info({ txHash, routeKey: candidate.routeKey, endpoint }, "Batch tx submitted");

          const receipt = await this._waitForReceipt(txHash);
          const success = !!receipt?.status;
          const gasUsed = receipt?.gasUsed ?? 0n;

          this.tracker.record({
            routeKey: candidate.routeKey,
            txHash,
            success,
            gasUsed,
            profit: 0n,
            timestamp: Date.now(),
            pools: poolsFromRouteKey(candidate.routeKey),
            error: success ? undefined : "reverted",
          });

          if (!success && receipt) {
            this.logger.warn({ txHash, routeKey: candidate.routeKey }, "Batch tx reverted");
            this._addQuarantine(candidate.routeKey);
          } else if (success) {
            this.quarantine.delete(candidate.routeKey);
          }

          return { success, txHash, gasUsed };
        } catch (err: any) {
          const msg = err?.message || String(err);
          this.logger.warn({ routeKey: candidate.routeKey, error: msg }, "Batch tx failed");
          this._addQuarantine(candidate.routeKey);
          return { success: false, error: msg };
        }
      })();

      pending.push({ index: i, promise });
    }

    await Promise.all(pending.map(p => p.promise.then(r => { results[p.index] = r; })));
    return results;
  }

  private async _waitForReceipt(txHash: string): Promise<{ status: boolean; gasUsed: bigint } | null> {
    if (!this.receiptClient) return null;
    const deadline = Date.now() + this.receiptTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const receipt = await this.receiptClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
        if (receipt) {
          return { status: receipt.status === "success", gasUsed: receipt.gasUsed };
        }
      } catch {
        // Receipt not yet available
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  isQuarantined(routeKey: string): boolean {
    return this.quarantine.has(routeKey);
  }

  private _addQuarantine(routeKey: string): void {
    if (this.quarantine.size >= this.MAX_QUARANTINE) {
      const oldest = this._quarantineQueue.shift();
      if (oldest) this.quarantine.delete(oldest);
    }
    this.quarantine.add(routeKey);
    this._quarantineQueue.push(routeKey);
  }
}
