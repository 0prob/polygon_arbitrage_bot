import type { Logger } from "../../infra/observability/logger.ts";
import { scalePriorityFeeByProfitMargin } from "./gas.ts";
import type { GasOracle } from "./gas.ts";
import type { FastLaneSubmitter } from "../../infra/rpc/fastlane.ts";
import { SubmissionStrategy as SubmissionStrategyEnum } from "../../config/schema.ts";

export type SubmitTxFn = (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }) => Promise<string>;

export interface SubmissionStrategyOptions {
  submissionStrategy?: SubmissionStrategyEnum;
  privateSubmitter?: SubmitTxFn;
  fastLaneSubmitter?: FastLaneSubmitter;
}

export class SubmissionStrategy {
  private readonly strategy: SubmissionStrategyEnum;
  private readonly privateSubmitter: SubmitTxFn | null;
  private readonly fastLaneSubmitter: FastLaneSubmitter | null;

  constructor(
    private logger: Logger,
    private gasOracle: GasOracle,
    private submitters: SubmitTxFn[],
    options: SubmissionStrategyOptions = {},
  ) {
    this.strategy = options.submissionStrategy ?? "hybrid";
    this.privateSubmitter = options.privateSubmitter ?? null;
    this.fastLaneSubmitter = options.fastLaneSubmitter ?? null;
  }

  async submit(
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

    if (this.strategy === "private" && this.privateSubmitter) {
      const txHash = await submit(this.privateSubmitter);
      return { txHash, endpoint: "private" };
    }

    if (this.strategy === "hybrid" && this.privateSubmitter) {
      try {
        const txHash = await Promise.race([
          submit(this.privateSubmitter).then((h) => ({ txHash: h, endpoint: "private" as const })),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("private timeout")), 2_000)),
        ]);
        if (txHash) return txHash;
      } catch (_err: unknown) {
        this.logger.debug({}, "Private submission failed, falling back to public");
      }
    }

    const txHash = await Promise.any(this.submitters.map((fn) => submit(fn)));
    return { txHash, endpoint: "public" };
  }
}
