import type { Logger } from "../../infra/observability/logger.ts";
import type { SignalHandler, MempoolSignal, LargeSwapSignal } from "./signals.ts";
import { decodeSwapCalldata, SELECTORS } from "./decoder.ts";
import type { PendingStateOverlay } from "../../core/types/overlay.ts";

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
    private overlay?: PendingStateOverlay,
  ) {}

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  setKnownPools(pools: string[]): void {
    this.knownPools = new Set(pools.map((p) => p.toLowerCase()));
    this.logger.debug({ count: this.knownPools.size }, "MempoolService known pools updated");
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

    const selector = tx.input.slice(0, 10).toLowerCase();
    if (SELECTORS[selector]) {
      this.logger.debug({ to: tx.to, selector, hash: tx.hash.slice(0, 10) + "..." }, "mempool: swap-like tx seen");
    }

    if (tx.input.startsWith("0xc9c65396") || tx.input.startsWith("0xa1671295")) {
      this.emit({ type: "new_pool_pending", data: { txHash: tx.hash, factoryAddress: tx.to as `0x${string}` } });
      // We don't return here, might also be a swap if someone is being weird, though unlikely
    }

    const decoded = decodeSwapCalldata(tx.to as `0x${string}`, tx.input, this.knownPools);
    if (!decoded) return;

    if (this.overlay && decoded.protocol === "UNISWAP_V2") {
      // Heuristic state update for V2
      const amount = decoded.amountIn;
      if (decoded.zeroForOne) {
        this.overlay.update(decoded.poolAddress, { reserve0: amount, reserve1: -amount });
      } else {
        this.overlay.update(decoded.poolAddress, { reserve0: -amount, reserve1: amount });
      }
    }

    const isIndirect = decoded.poolAddress.toLowerCase() !== (tx.to || "").toLowerCase();
    const effectiveSize = isIndirect
      ? this.options.largeSwapThresholdWei
      : decoded.amountIn;
    if (!isIndirect && effectiveSize < this.options.largeSwapThresholdWei) {
      this.logger.debug(
        { pool: decoded.poolAddress, amount: decoded.amountIn.toString(), thresh: this.options.largeSwapThresholdWei.toString() },
        "mempool: decoded swap below threshold",
      );
      return;
    }

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
      estimatedSwapSize: effectiveSize,
      zeroForOne: decoded.zeroForOne,
    };
    this.emit({ type: "large_swap", data: signal });
  }
}
