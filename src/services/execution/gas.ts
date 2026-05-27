import { FeeSnapshot } from "../../core/types/common.ts";

export interface GasOracleConfig {
  pollIntervalMs: number;
  priorityFeeFloorGwei: number;
  priorityFeeCeilingGwei: number;
  maxBidMultiplier: number;
  eip1559Enabled: boolean;
  feeHistoryPercentile: number;
  emaAlpha: number;
  baseFeeBufferMultiplier: number;
  maxPriorityFeePercentile: number;
  historySize: number;
}

export const DEFAULT_GAS_CONFIG: GasOracleConfig = {
  pollIntervalMs: 1_000,
  priorityFeeFloorGwei: 1,
  priorityFeeCeilingGwei: 50,
  maxBidMultiplier: 3,
  eip1559Enabled: true,
  feeHistoryPercentile: 50,
  emaAlpha: 0.3,
  baseFeeBufferMultiplier: 1.1,
  maxPriorityFeePercentile: 75,
  historySize: 20,
};

export interface PolygonGasHints {
  congestion: number;
  recommendedPriorityFee: bigint;
  isSpiking: boolean;
}

export class GasOracle {
  private current: FeeSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseFeeHistory: bigint[] = [];
  private priorityFeeHistory: bigint[] = [];
  private emaBaseFee: bigint | null = null;

  constructor(
    public config: GasOracleConfig = DEFAULT_GAS_CONFIG,
    private fetchGas: () => Promise<{ baseFee: bigint; priorityFee: bigint }>,
  ) {}

  getSnapshot(): FeeSnapshot | null {
    return this.current;
  }

  getPredictedBaseFee(): bigint | null {
    return this.emaBaseFee;
  }

  estimateCongestion(): PolygonGasHints {
    const current = this.current;
    if (!current || this.baseFeeHistory.length < 2) {
      return { congestion: 0, recommendedPriorityFee: 0n, isSpiking: false };
    }
    const avg = this.baseFeeHistory.reduce((a, b) => a + b, 0n) / BigInt(this.baseFeeHistory.length);
    const ratio = avg === 0n ? 1 : Number(current.baseFee) / Number(avg);
    const congestion = Math.min(1, Math.max(0, ratio - 1));
    const isSpiking = ratio > 1.5;
    const recommendedPriorityFee = this.computePercentilePriorityFee();
    return { congestion, recommendedPriorityFee, isSpiking };
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.refresh();
    this.timer = setInterval(() => this.refresh(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const { baseFee, priorityFee } = await this.fetchGas();

      this.baseFeeHistory.push(baseFee);
      if (this.baseFeeHistory.length > this.config.historySize) {
        this.baseFeeHistory.shift();
      }

      this.priorityFeeHistory.push(priorityFee);
      if (this.priorityFeeHistory.length > this.config.historySize) {
        this.priorityFeeHistory.shift();
      }

      // EMA for base fee prediction
      if (this.emaBaseFee === null) {
        this.emaBaseFee = baseFee;
      } else {
        const alpha = BigInt(Math.round(this.config.emaAlpha * 100));
        const oneMinusAlpha = 100n - alpha;
        this.emaBaseFee = (this.emaBaseFee * oneMinusAlpha + baseFee * alpha) / 100n;
      }

      const clampedPriority = this.config.eip1559Enabled ? this.computeDynamicPriorityFee() : clampPriorityFee(priorityFee, this.config);

      const predictedBase =
        this.config.eip1559Enabled && this.emaBaseFee !== null
          ? (this.emaBaseFee * BigInt(Math.round(this.config.baseFeeBufferMultiplier * 100))) / 100n
          : baseFee;

      const maxFee = predictedBase * 2n + clampedPriority;
      this.current = {
        baseFee,
        priorityFee: clampedPriority,
        maxFee,
        gasPrice: predictedBase + clampedPriority,
        timestamp: Date.now(),
      };
    } catch (_err: unknown) {
      // Keep last known values on fetch failure
    }
  }

  private computePercentilePriorityFee(): bigint {
    if (this.priorityFeeHistory.length === 0) return 1n * 10n ** 9n;
    const sorted = [...this.priorityFeeHistory].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const idx = Math.min(Math.floor((sorted.length * this.config.maxPriorityFeePercentile) / 100), sorted.length - 1);
    return sorted[idx];
  }

  private computeDynamicPriorityFee(): bigint {
    const percentileFee = this.computePercentilePriorityFee();
    return clampPriorityFee(percentileFee, this.config);
  }
}

function clampPriorityFee(priorityFee: bigint, config: GasOracleConfig): bigint {
  const floor = BigInt(config.priorityFeeFloorGwei) * 1_000_000_000n;
  const ceiling = BigInt(config.priorityFeeCeilingGwei) * 1_000_000_000n;
  if (priorityFee < floor) return floor;
  if (priorityFee > ceiling) return ceiling;
  return priorityFee;
}

/**
 * Scale the priority fee based on the expected profit.
 * This ensures we bid aggressively for high-value opportunities
 * and conservatively for marginal ones.
 *
 * @param basePriorityFee The current network priority fee (median)
 * @param expectedProfitWei The expected net profit in token-wei
 * @param maxBidMultiplier Maximum multiplier to apply to the base fee
 */
export function scalePriorityFeeByProfitMargin(
  basePriorityFee: bigint,
  expectedProfitWei: bigint,
  maxBidMultiplier: number = 3
): bigint {
  if (expectedProfitWei <= 0n) return basePriorityFee;

  // We are willing to spend a portion of the expected profit on priority fees
  // to beat competitors.
  const maxBidFromProfit = expectedProfitWei / 2n;

  // Tiered multiplier strategy
  let multiplier = 1.1;
  // If profit > 10 MATIC (assuming 1e18), bid more aggressively
  if (expectedProfitWei > 10n ** 19n) multiplier = 2.0;
  // If profit > 50 MATIC, go to max
  if (expectedProfitWei > 5n * 10n ** 19n) multiplier = maxBidMultiplier;

  const bid = (basePriorityFee * BigInt(Math.floor(multiplier * 100))) / 100n;

  // Final safety check: Never bid more than 50% of our expected profit
  return bid > maxBidFromProfit ? maxBidFromProfit : bid;
}
