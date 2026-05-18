import type { Address } from "../../core/types/common.ts";

export interface FeeSnapshot {
  baseFee: bigint;
  priorityFee: bigint;
  maxFee: bigint;
  gasPrice: bigint;
  timestamp: number;
}

export interface GasOracleConfig {
  pollIntervalMs: number;
  priorityFeeFloorGwei: number;
  priorityFeeCeilingGwei: number;
  maxBidMultiplier: number;
}

export const DEFAULT_GAS_CONFIG: GasOracleConfig = {
  pollIntervalMs: 1_000,
  priorityFeeFloorGwei: 1,
  priorityFeeCeilingGwei: 50,
  maxBidMultiplier: 3,
};

export interface PolygonGasHints {
  congestion: number;
  recommendedPriorityFee: bigint;
  isSpiking: boolean;
}

export class GasOracle {
  private current: FeeSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: FeeSnapshot[] = [];
  private static readonly HISTORY_SIZE = 10;

  constructor(
    private config: GasOracleConfig = DEFAULT_GAS_CONFIG,
    private fetchGas: () => Promise<{ baseFee: bigint; priorityFee: bigint }>,
  ) {}

  getSnapshot(): FeeSnapshot | null {
    return this.current;
  }

  estimateCongestion(): PolygonGasHints {
    const current = this.current;
    if (!current || this.history.length < 2) {
      return { congestion: 0, recommendedPriorityFee: 0n, isSpiking: false };
    }
    const sum = this.history.reduce((a, b) => a + b.baseFee, 0n);
    const avg = sum / BigInt(this.history.length);
    const ratio = avg === 0n ? 1 : Number(current.baseFee) / Number(avg);
    const congestion = Math.min(1, Math.max(0, ratio - 1));
    const isSpiking = ratio > 1.5;
    const recommendedPriorityFee = BigInt(Math.round(Number(current.baseFee) * ratio * 0.1));
    return { congestion, recommendedPriorityFee, isSpiking };
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => this.refresh(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const { baseFee, priorityFee } = await this.fetchGas();
      const clampedPriority = clampPriorityFee(priorityFee, this.config);
      const maxFee = baseFee * 2n + clampedPriority;
      this.current = {
        baseFee, priorityFee: clampedPriority, maxFee, gasPrice: baseFee + clampedPriority,
        timestamp: Date.now(),
      };
      this.history.push(this.current);
      if (this.history.length > GasOracle.HISTORY_SIZE) {
        this.history.shift();
      }
    } catch {
      // Keep last known values on fetch failure
    }
  }
}

function clampPriorityFee(priorityFee: bigint, config: GasOracleConfig): bigint {
  const floor = BigInt(config.priorityFeeFloorGwei) * 1_000_000_000n;
  const ceiling = BigInt(config.priorityFeeCeilingGwei) * 1_000_000_000n;
  if (priorityFee < floor) return floor;
  if (priorityFee > ceiling) return ceiling;
  return priorityFee;
}

export function scalePriorityFeeByProfitMargin(
  priorityFee: bigint,
  profitMarginBps: bigint,
  maxMultiplier: number,
): bigint {
  const multiplier = Math.max(1, Math.min(maxMultiplier, Number(profitMarginBps) / 100));
  return priorityFee * BigInt(multiplier);
}
