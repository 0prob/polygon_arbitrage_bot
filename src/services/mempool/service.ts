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

    // Noise filter for common non-swap selectors (checked BEFORE decoder).
    // These are not DEX swaps even if they interact with known pools.
    const IGNORED_SELECTORS = new Set([
      "0xe3ee160e", // transferWithAuthorization (USDC)
      "0xd286f3cf", // claimInterest
      "0xa9059cbb", // transfer(address,uint256)
      "0x095ea7b3", // approve(address,uint256)
      "0x3c2b4399", // POLYMARKET_CTF matchOrders
      "0x3829cab1", // CLAIM_INTEREST
      "0x6a761202", // GNOSIS_SAFE execTransaction
      "0x46a73fb1", // SILENCE
      "0xa694fc3a", // STAKE
      "0x5638f1f3", // REDEEM_SILENCE
      "0xd9f0f7f5", // UNSTAKE_PRINCIPAL
      "0x0a3c4405", // POLYMARKET_DEPOSIT
    ]);
    if (IGNORED_SELECTORS.has(selector)) return;

    // Selectors that route through a vault/router (not pool-direct calls)
    const ROUTER_SELECTORS = new Set(["0x52bbbe29", "0x5c11d795"]);

    // Log incoming transaction
    this.logger.debug({ hash: tx.hash, to: tx.to, selector }, "mempool: processing tx");

    if (tx.input.startsWith("0xc9c65396") || tx.input.startsWith("0xa1671295")) {
      this.emit({
        type: "new_pool_pending",
        data: { traceId, txHash: tx.hash, factoryAddress: tx.to as `0x${string}` },
      });
    }

    // Dynamic Pool Learning: unknown to but known direct-pool selector — tentatively learn the target before decoding.
    // This ensures that decodeSwapCalldata succeeds for the current transaction rather than just future ones.
    const isDirectPoolSelector = SELECTORS[selector] !== undefined && !ROUTER_SELECTORS.has(selector);
    if (isDirectPoolSelector && tx.to && !this.knownPools.has(tx.to.toLowerCase())) {
      this.logger.debug({ pool: tx.to.toLowerCase(), selector }, "mempool: dynamically learned new pool");
      this.knownPools.add(tx.to.toLowerCase());
    }

    const decoded = decodeSwapCalldata(tx.to as `0x${string}`, tx.input, this.knownPools);
    if (!decoded) {
      this.logger.debug({ hash: tx.hash, selector }, "mempool: ignored tx (no decoded swap)");
      return;
    }

    // Dynamic Pool Learning: after successful decode, ensure the resolved pool is known
    if (!this.knownPools.has(decoded.poolAddress.toLowerCase())) {
      this.logger.debug({ pool: decoded.poolAddress, selector }, "mempool: dynamically learned decoded pool");
      this.knownPools.add(decoded.poolAddress.toLowerCase());
    }

    if (this.overlay) {
      if (decoded.protocol.startsWith("UNISWAP_V2")) {
        this.logger.debug({ pool: decoded.poolAddress, amount: decoded.amountIn.toString() }, "mempool: updating V2 overlay");
        const amount = decoded.amountIn;
        if (decoded.zeroForOne) {
          this.overlay.update(decoded.poolAddress, { reserve0: amount });
        } else {
          this.overlay.update(decoded.poolAddress, { reserve1: amount });
        }
      } else if (decoded.protocol.startsWith("UNISWAP_V3") && decoded.zeroForOne !== undefined) {
        // V3 overlay: mark state dirty for the dry runner by setting a sentinel.
        // The exact sqrtPriceX96 projection requires running the swap math, which
        // is deferred to the dry runner. Setting { pendingV3: true } triggers a
        // fresh RPC read for this pool before the dry run.
        this.logger.debug({ pool: decoded.poolAddress }, "mempool: marking V3 pool dirty for overlay");
        this.overlay.update(decoded.poolAddress, { pendingV3: true });
      }
    }

    const isIndirect = decoded.poolAddress.toLowerCase() !== (tx.to || "").toLowerCase();
    const effectiveSize = isIndirect ? this.options.largeSwapThresholdWei : decoded.amountIn;
    if (!isIndirect && effectiveSize < this.options.largeSwapThresholdWei) {
      this.logger.debug(
        {
          pool: decoded.poolAddress,
          amount: decoded.amountIn.toString(),
          thresh: this.options.largeSwapThresholdWei.toString(),
          hash: tx.hash,
        },
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
