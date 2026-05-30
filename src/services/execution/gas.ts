import { FeeSnapshot } from "../../core/types/common.ts";
import type { PublicClient } from "viem";

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
  /** Multiplier applied to maxBidMultiplier when congestion spike is detected */
  spikePriorityFeeMultiplier: number;
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
  spikePriorityFeeMultiplier: 1.6,
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

  /**
   * Returns the effective max bid multiplier.
   * During detected congestion spikes (rapid base fee increase), this returns
   * a boosted value so the bot bids more aggressively exactly when needed to win races.
   */
  getEffectiveMaxBidMultiplier(): number {
    const base = this.config.maxBidMultiplier;
    const hints = this.estimateCongestion();
    if (hints.isSpiking && this.config.spikePriorityFeeMultiplier > 1) {
      return base * this.config.spikePriorityFeeMultiplier;
    }
    return base;
  }
}

/** Options for the dual-source gas fetcher */
export interface GasFetcherOptions {
  feeHistoryPercentile: number;
  /** Number of recent blocks to query in eth_feeHistory (small window is sufficient) */
  feeHistoryBlockCount?: number;
}

/**
 * Creates a robust gas fetcher that combines two priority fee sources:
 * 1. The client's native estimateMaxPriorityFeePerGas()
 * 2. Explicit eth_feeHistory reward at the configured percentile
 *
 * Takes the higher of the two (conservative) when both succeed.
 * This protects against individual RPCs returning stale or under-estimated priority fees,
 * which is especially common on Polygon during volatility.
 */
export function createGasFetcher(
  client: PublicClient,
  opts: GasFetcherOptions,
): () => Promise<{ baseFee: bigint; priorityFee: bigint }> {
  const percentile = Math.max(0, Math.min(100, Math.floor(opts.feeHistoryPercentile)));
  const blockCount = opts.feeHistoryBlockCount ?? 2;
  const fallback = 30n * 10n ** 9n;

  return async () => {
    try {
      const [block, priorityFromClient, feeHistory] = await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        client.estimateMaxPriorityFeePerGas().catch(() => null),
        client
          .getFeeHistory({
            blockCount,
            blockTag: "latest",
            rewardPercentiles: [percentile],
          })
          .catch(() => null),
      ]);

      const baseFee = block.baseFeePerGas ?? fallback;

      let priorityFromHistory: bigint | null = null;
      if (feeHistory?.reward && feeHistory.reward.length > 0) {
        // Most recent block's reward array for the requested percentile(s)
        const latestRewards = feeHistory.reward[0];
        if (latestRewards && latestRewards.length > 0) {
          const v = latestRewards[0];
          if (typeof v === "bigint" && v > 0n) {
            priorityFromHistory = v;
          }
        }
      }

      // Conservative policy: when both sources report, take the higher value.
      // This biases toward landing the transaction during uncertain/volatile periods.
      let priorityFee: bigint;
      if (priorityFromClient && priorityFromHistory) {
        priorityFee = priorityFromClient > priorityFromHistory ? priorityFromClient : priorityFromHistory;
      } else {
        priorityFee = priorityFromClient ?? priorityFromHistory ?? fallback;
      }

      if (priorityFee <= 0n) priorityFee = fallback;

      return { baseFee, priorityFee };
    } catch (_err: unknown) {
      return { baseFee: fallback, priorityFee: fallback };
    }
  };
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
export function scalePriorityFeeByProfitMargin(basePriorityFee: bigint, expectedProfitWei: bigint, maxBidMultiplier: number = 3): bigint {
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
