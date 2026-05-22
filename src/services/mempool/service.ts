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
  private knownPools = new Set<string>();
  private lastEmitByPool = new Map<string, number>();

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
    this.logger.info({}, "MempoolService started");
  }

  stop(): void {
    this.logger.info({}, "MempoolService stopped");
  }

  private emit(signal: MempoolSignal): void {
    for (const h of this.handlers) h(signal);
  }

  private readonly MAX_EMIT_CACHE = 5000;

  /** Process a pending transaction from the mempool with coalescing. */
  processPendingTx(tx: { hash: string; to: string | null; input: string; value: string }): void {
    if (!tx.to || !tx.input) return;

    const decoded = decodeSwapCalldata(tx.to as any, tx.input, this.knownPools);
    if (!decoded || decoded.amountIn < this.options.largeSwapThresholdWei) return;

    const poolKey = decoded.poolAddress.toLowerCase();
    const now = Date.now();
    const lastEmit = this.lastEmitByPool.get(poolKey);
    if (lastEmit != null && now - lastEmit < this.options.coalesceTtlMs) return;
    this.lastEmitByPool.set(poolKey, now);

    if (this.lastEmitByPool.size > this.MAX_EMIT_CACHE) {
      const oldest = this.lastEmitByPool.entries().next();
      if (oldest.value) {
        this.lastEmitByPool.delete(oldest.value[0]);
      }
    }

    const signal: LargeSwapSignal = {
      txHash: tx.hash,
      poolAddress: decoded.poolAddress,
      tokenIn: decoded.tokenIn,
      tokenOut: decoded.tokenOut,
      estimatedSwapSize: decoded.amountIn,
      zeroForOne: decoded.zeroForOne,
    };
    this.emit({ type: "large_swap", data: signal });
  }
}
