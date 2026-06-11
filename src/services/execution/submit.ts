import type { Logger } from "../../infra/observability/logger.ts";
import { scalePriorityFeeByProfitMargin } from "./gas.ts";
import type { GasOracle } from "./gas.ts";
import { SubmissionStrategy as SubmissionStrategyEnum } from "../../config/schema.ts";

export type SubmitTxFn = (tx: {
  to: string;
  data: string;
  value: bigint;
  nonce: number;
  maxFee: bigint;
  maxPriorityFee: bigint;
}) => Promise<string>;

export interface SubmissionStrategyOptions {
  submissionStrategy?: SubmissionStrategyEnum;
  privateSubmitter?: SubmitTxFn;
}

export class SubmissionStrategy {
  private readonly strategy: SubmissionStrategyEnum;
  private readonly privateSubmitter: SubmitTxFn | null;

  constructor(
    private logger: Logger,
    private gasOracle: GasOracle,
    private submitters: SubmitTxFn[],
    options: SubmissionStrategyOptions = {},
  ) {
    this.strategy = options.submissionStrategy ?? "hybrid";
    this.privateSubmitter = options.privateSubmitter ?? null;
  }

  async submit(
    tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint },
    expectedProfit?: bigint,
    gasLimit?: bigint,
  ): Promise<{ txHash: string; endpoint: string }> {
    const snapshot = this.gasOracle.getSnapshot();
    let adjustedFee = tx.maxFee;
    let maxPriorityFee = snapshot ? snapshot.priorityFee : 1_000_000_000n; // fallback to 1 Gwei
    if (expectedProfit && expectedProfit > 0n && snapshot) {
      const multiplier = this.gasOracle.getEffectiveMaxBidMultiplier();
      const scaled = scalePriorityFeeByProfitMargin(snapshot.priorityFee, expectedProfit, multiplier, gasLimit);
      maxPriorityFee = scaled;
      adjustedFee = (this.gasOracle.getPredictedBaseFee() ?? snapshot.baseFee) * 2n + scaled;
    }

    const submit = async (fn: SubmitTxFn) => fn({ ...tx, maxFee: adjustedFee, maxPriorityFee });

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
      } catch (err) {
        this.logger.debug?.({ err }, "Private submission failed, falling back to public");
      }
    }

    const txHash = await Promise.any(this.submitters.map((fn) => submit(fn)));
    return { txHash, endpoint: "public" };
  }
}
