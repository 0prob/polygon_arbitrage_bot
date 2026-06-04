import type { Logger } from "../../infra/observability/logger.ts";
import type { GasOracle } from "./gas.ts";
import type { NonceManager } from "./nonce.ts";
import { ExecutionTracker } from "./tracker.ts";
import { QuarantineManager } from "./quarantine.ts";
import { getAddress, decodeEventLog } from "viem";
import { SubmissionStrategy, type SubmitTxFn } from "./submit.ts";
import { ReceiptPoller } from "./receipt.ts";
import { getTraceMessages } from "../../infra/hypersync/trace_parser.ts";

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
  traceId?: string;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: bigint;
  /** Useful human-readable insights derived from the trace parser (for TUI/logs) */
  traceMessages?: string[];
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
  private inFlightRouteHashes = new Map<string, number>();

  private cleanInFlight(): void {
    const cutoff = Date.now() - 35_000;
    for (const [key, ts] of this.inFlightRouteHashes) {
      if (ts < cutoff) this.inFlightRouteHashes.delete(key);
    }
  }

  private isInFlight(routeKey: string): boolean {
    this.cleanInFlight();
    return this.inFlightRouteHashes.has(routeKey);
  }

  private markInFlight(routeKey: string): void {
    this.cleanInFlight();
    this.inFlightRouteHashes.set(routeKey, Date.now());
  }

  constructor(
    private logger: Logger,
    private submissionStrategy: SubmissionStrategy,
    private receiptPoller: ReceiptPoller,
    private gasOracle: GasOracle,
    private nonceManager: NonceManager,
    quarantineBaseMs: number = 2000,
    quarantineMaxMs: number = 600_000,
  ) {
    this.quarantine = new QuarantineManager(quarantineBaseMs, quarantineMaxMs);
  }

  async start(): Promise<void> {
    await this.gasOracle.start();
    await this.nonceManager.initialize();
    this.logger.info({}, "ExecutionService started");
  }

  stop(): void {
    this.gasOracle.stop();
    this.logger.info({}, "ExecutionService stopped");
  }

  async execute(candidate: CandidateExecution): Promise<ExecutionResult> {
    if (this.quarantine.isQuarantined(candidate.routeKey)) {
      const entry = this.quarantine.getEntry(candidate.routeKey);
      return { success: false, error: `route quarantined (backoff: attempt ${entry?.attempt ?? 0})` };
    }

    if (this.isInFlight(candidate.routeKey)) {
      return { success: false, error: "route already in-flight (same calldata pending)" };
    }

    try {
      const fee = this.gasOracle.getSnapshot();
      if (!fee) {
        this.quarantine.add(candidate.routeKey, "no gas data");
        return { success: false, error: "no gas data" };
      }

      this.markInFlight(candidate.routeKey);
      const nonce = this.nonceManager.getNextNonce();
      this.nonceManager.markInFlight(nonce);
      const { txHash, endpoint } = await this.submissionStrategy.submit(
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

      const receipt = await this.receiptPoller.wait(txHash);
      const success = !!receipt?.status;
      const gasUsed = receipt?.gasUsed ?? 0n;

      // Capture useful trace insights for TUI and logging
      const traceMessages = receipt?.traceSummary ? getTraceMessages(receipt.traceSummary) : undefined;

      let profit = 0n;
      if (success && receipt && candidate.profitToken) {
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

      this.inFlightRouteHashes.delete(candidate.routeKey);

      if (!success && receipt) {
        this.logger.warn({ txHash, routeKey: candidate.routeKey }, "Transaction reverted");
        this.quarantine.add(candidate.routeKey, "reverted");
      } else if (success) {
        this.quarantine.recordSuccess(candidate.routeKey);
      }

      return { success, txHash, gasUsed, traceMessages };
    } catch (err: any) {
      this.inFlightRouteHashes.delete(candidate.routeKey);
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

      if (this.isInFlight(candidate.routeKey)) {
        results[i] = { success: false, error: "route already in-flight" };
        continue;
      }

      this.markInFlight(candidate.routeKey);
      const nonce = this.nonceManager.getNextNonce();
      this.nonceManager.markInFlight(nonce);

      try {
        const { txHash, endpoint } = await this.submissionStrategy.submit(
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
        this.inFlightRouteHashes.delete(candidate.routeKey);
        const msg = err?.message || String(err);
        this.logger.warn({ routeKey: candidate.routeKey, error: msg, nonce }, "Batch submission failed");
        this.quarantine.add(candidate.routeKey, msg);
        results[i] = { success: false, error: msg };
      }
    }

    // Phase 2: Parallel Receipt Waiting
    await Promise.all(
      receiptPromises.map(async ({ index, txHash, nonce, candidate }) => {
        try {
          const receipt = await this.receiptPoller.wait(txHash);
          if (!receipt) {
            this.inFlightRouteHashes.delete(candidate.routeKey);
            this.nonceManager.markStale(nonce);
            this.logger.warn({ txHash, routeKey: candidate.routeKey }, "No receipt received within timeout — marking nonce stale");
            results[index] = { success: false, txHash, error: "timeout" };
            return;
          }

          const success = !!receipt.status;
          const gasUsed = receipt.gasUsed;

          const traceMessages = receipt.traceSummary ? getTraceMessages(receipt.traceSummary) : undefined;

          let profit = 0n;
          if (success && candidate.profitToken) {
            const execAddr = getAddress(candidate.targetAddress);
            const logs = receipt.logs;
            profit = parseTransferLogs(logs, execAddr);
          }

          this.inFlightRouteHashes.delete(candidate.routeKey);
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

          results[index] = { success, txHash, gasUsed, traceMessages };
        } catch (err: any) {
          this.inFlightRouteHashes.delete(candidate.routeKey);
          const msg = err?.message || String(err);
          this.logger.error({ txHash, error: msg }, "Error waiting for batch receipt");
          results[index] = { success: false, txHash, error: msg };
        }
      }),
    );

    // Fill in any remaining gaps
    for (let i = 0; i < results.length; i++) {
      if (!results[i]) results[i] = { success: false, error: "unknown error" };
    }

    return results;
  }

  isQuarantined(routeKey: string): boolean {
    return this.quarantine.isQuarantined(routeKey);
  }

  getQuarantineManager(): QuarantineManager {
    return this.quarantine;
  }
}

export type { SubmitTxFn };
