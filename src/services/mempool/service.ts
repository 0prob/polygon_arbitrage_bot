import type { Logger } from "../../infra/observability/logger.ts";
import type { SignalHandler, MempoolSignal, LargeSwapSignal } from "./signals.ts";
import { decodeSwapCalldata } from "./decoder.ts";

export interface MempoolServiceOptions {
  coalesceTtlMs: number;
  largeSwapThresholdWei: bigint;
}

export const DEFAULT_MEMPOOL_OPTIONS: MempoolServiceOptions = {
  coalesceTtlMs: 100,
  largeSwapThresholdWei: 10n ** 18n, // 1 MATIC equivalent
};

export class MempoolService {
  private handlers: SignalHandler[] = [];
  private running = false;
  private knownPools = new Set<string>();

  constructor(
    private logger: Logger,
    private options: MempoolServiceOptions = DEFAULT_MEMPOOL_OPTIONS,
  ) {}

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  setKnownPools(pools: string[]): void {
    this.knownPools = new Set(pools.map((p) => p.toLowerCase()));
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info({}, "MempoolService started");
  }

  stop(): void {
    this.running = false;
    this.logger.info({}, "MempoolService stopped");
  }

  private emit(signal: MempoolSignal): void {
    for (const h of this.handlers) h(signal);
  }

  /** Process a pending transaction from the mempool. */
  processPendingTx(tx: { hash: string; to: string | null; input: string; value: string }): void {
    if (!tx.to || !tx.input) return;

    const decoded = decodeSwapCalldata(tx.to as any, tx.input, this.knownPools);
    if (decoded && decoded.amountIn >= this.options.largeSwapThresholdWei) {
      const signal: LargeSwapSignal = {
        txHash: tx.hash,
        poolAddress: decoded.poolAddress,
        tokenIn: decoded.tokenIn,
        tokenOut: decoded.tokenOut,
        estimatedSwapSize: decoded.amountIn,
      };
      this.emit({ type: "large_swap", data: signal });
    }
  }
}
