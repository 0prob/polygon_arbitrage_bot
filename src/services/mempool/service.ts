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
    if (!tx.to || !tx.input) {
      this.logger.debug({ hash: tx.hash }, "mempool: ignored tx (no to/input)");
      return;
    }

    const traceId = "tx-" + tx.hash.slice(2, 8);
    const selector = tx.input.slice(0, 10).toLowerCase();
    
    // Noise filter for common non-swap selectors
    const IGNORED_SELECTORS = new Set([
      "0xe3ee160e", // transferWithAuthorization (USDC)
      "0xd286f3cf", // claimInterest
      "0xa9059cbb", // transfer(address,uint256)
      "0x095ea7b3", // approve(address,uint256)
    ]);
    if (IGNORED_SELECTORS.has(selector)) return;

    // Log incoming transaction
    this.logger.debug({ hash: tx.hash, to: tx.to, selector }, "mempool: processing tx");

    if (tx.input.startsWith("0xc9c65396") || tx.input.startsWith("0xa1671295")) {
      this.emit({
        type: "new_pool_pending",
        data: { traceId, txHash: tx.hash, factoryAddress: tx.to as `0x${string}` },
      });
    }

    const lcTo = tx.to.toLowerCase();
    let isKnown = this.knownPools.has(lcTo);
    
    // Dynamic Pool Learning: If selector is known, tentatively trust the pool
    if (!isKnown && SELECTORS[selector]) {
      this.logger.debug({ pool: lcTo, selector }, "mempool: dynamically learned new pool");
      this.knownPools.add(lcTo);
      isKnown = true;
    }

    const decoded = decodeSwapCalldata(tx.to as `0x${string}`, tx.input, this.knownPools);
    if (!decoded) {
      console.debug(`mempool: ignored tx (no decoded swap for ${tx.hash}, selector: ${selector})`);
      return;
    }

    if (this.overlay && decoded.protocol === "UNISWAP_V2") {
      this.logger.debug({ pool: decoded.poolAddress, amount: decoded.amountIn.toString() }, "mempool: updating overlay");
      const amount = decoded.amountIn;
      if (decoded.zeroForOne) {
        this.overlay.update(decoded.poolAddress, { reserve0: amount });
      } else {
        this.overlay.update(decoded.poolAddress, { reserve1: amount });
      }
    }

    const isIndirect = decoded.poolAddress.toLowerCase() !== (tx.to || "").toLowerCase();
    const effectiveSize = isIndirect ? this.options.largeSwapThresholdWei : decoded.amountIn;
    if (!isIndirect && effectiveSize < this.options.largeSwapThresholdWei) {
      console.debug(
        { pool: decoded.poolAddress, amount: decoded.amountIn.toString(), thresh: this.options.largeSwapThresholdWei.toString(), hash: tx.hash },
        "mempool: decoded swap below threshold",
      );
      return;
    }

    const poolKey = decoded.poolAddress.toLowerCase();
    const now = Date.now();
    const lastEmit = this.lastEmitByPool.get(poolKey);
    if (lastEmit != null && now - lastEmit < this.options.coalesceTtlMs) return;

    // Delete first to ensure it's moved to the end of the Map's insertion order (LRU behavior)
    this.lastEmitByPool.delete(poolKey);
    this.lastEmitByPool.set(poolKey, now);

    if (this.lastEmitByPool.size > this.MAX_EMIT_CACHE) {
      const oldest = this.lastEmitByPool.entries().next();
      if (oldest.value) {
        this.lastEmitByPool.delete(oldest.value[0]);
      }
    }

    this.logger.info(
      { pool: decoded.poolAddress, protocol: decoded.protocol, amount: decoded.amountIn.toString(), hash: tx.hash.slice(0, 10) + "..." },
      "mempool: emitting large_swap signal",
    );
    const signal: LargeSwapSignal = {
      traceId,
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
