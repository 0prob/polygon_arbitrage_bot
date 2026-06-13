import type { Logger } from "../../infra/observability/logger.ts";
import type { SignalHandler, MempoolSignal, LargeSwapSignal } from "./signals.ts";
import { decodeSwapCalldata } from "./decoder.ts";
import { join } from "node:path";
import type { PendingStateOverlay } from "../../core/types/overlay.ts";
import type { PoolState } from "../../core/types/pool.ts";
import { AbiRegistry } from "../../core/abis/registry.ts";
import { COMPILED_ABIS } from "../../core/abis/compiled/index.ts";
import type { Hex } from "viem";
import type { Address } from "../../core/types/common.ts";
import { PendingOverrideStore } from "./pending-override.ts";
import { buildStateOverride } from "./state-override-builder.ts";
import type { DecodedSwap } from "./decoder.ts";
import { resolveSwapAmountIn, computeV2OverlayDeltas } from "./pending-amount.ts";
import type { MempoolSimulator } from "./simulator.ts";

export interface MempoolServiceOptions {
  coalesceTtlMs: number;
  largeSwapThresholdWei: bigint;
  dataDir?: string;
  /** Lookup pool state for building Geth state overrides. */
  getPoolState?: (poolAddress: string) => PoolState | undefined;
  /** Invalidate cached tick data after mempool projection mutates pool state. */
  invalidatePoolTicks?: (poolAddress: string) => void;
  /** Trace fallback when manual override construction fails. */
  mempoolSimulator?: MempoolSimulator;
}

export const DEFAULT_MEMPOOL_OPTIONS: MempoolServiceOptions = {
  coalesceTtlMs: 100,
  largeSwapThresholdWei: 10n ** 18n, // 1 MATIC equivalent
};

export class MempoolService {
  private handlers: SignalHandler[] = [];
  private knownPools = new Set<string>();
  private lastEmitByPool = new Map<string, number>();
  private unknownSelectors = new Map<
    string,
    {
      selector: string;
      count: number;
      sampleTx: string;
      sampleTo: string;
      firstSeen: string;
      lastSeen: string;
    }
  >();
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private abiRegistry: AbiRegistry;

  constructor(
    private logger: Logger,
    private options: MempoolServiceOptions = DEFAULT_MEMPOOL_OPTIONS,
    private overlay?: PendingStateOverlay,
    private pendingOverrideStore?: PendingOverrideStore,
  ) {
    this.abiRegistry = new AbiRegistry();
    for (const [tag, abi] of Object.entries(COMPILED_ABIS)) {
      this.abiRegistry.registerAbi(abi as any, tag);
    }
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  setKnownPools(pools: string[]): void {
    this.knownPools = new Set(pools.map((p) => p.toLowerCase()));
    this.logger.debug({ count: this.knownPools.size }, "MempoolService known pools updated");
  }

  async start(): Promise<void> {
    this.logger.info({}, "MempoolService started");
    await this.loadUnknownSelectors();
  }

  async stop(): Promise<void> {
    this.logger.info({}, "MempoolService stopped");
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.writeUnknownSelectors();
  }

  private getUnknownSelectorsFilePath(): string {
    const dataDir = this.options.dataDir ?? "data";
    return join(dataDir, "unknown-selectors.json");
  }

  private async loadUnknownSelectors(): Promise<void> {
    const filePath = this.getUnknownSelectorsFilePath();
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      for (const [key, val] of Object.entries(data)) {
        this.unknownSelectors.set(key, val as any);
      }
      this.logger.info({ count: this.unknownSelectors.size }, "Loaded unknown selectors from file");
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        this.logger.warn({ err, filePath }, "Failed to load unknown selectors file");
      }
    }
  }

  private saveUnknownSelectors(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      void this.writeUnknownSelectors();
    }, 5000);
  }

  private async writeUnknownSelectors(): Promise<void> {
    const filePath = this.getUnknownSelectorsFilePath();
    try {
      const data = Object.fromEntries(this.unknownSelectors.entries());
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      this.logger.warn({ err, filePath }, "Failed to write unknown selectors file");
    }
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

    // Fast reject: skip ABI decode for unknown selectors
    if (!this.abiRegistry.hasSelector(selector)) {
      if (this.knownPools.has(tx.to.toLowerCase())) {
        this.trackUnknownSelector(selector, tx.to, tx.hash);
      }
      return;
    }

    // 1. Check for specific well-known signals first (factories, etc)
    const factoryDecoded = this.abiRegistry.decodeCall(tx.input as Hex);
    if (factoryDecoded) {
      if (factoryDecoded.tag === "uniswap_v2_factory" && factoryDecoded.functionName === "createPair") {
        this.emit({ type: "new_pool_pending", data: { traceId, txHash: tx.hash, factoryAddress: tx.to as Address } });
        return;
      }
      if (factoryDecoded.tag === "uniswap_v3_factory" && factoryDecoded.functionName === "createPool") {
        this.emit({ type: "new_pool_pending", data: { traceId, txHash: tx.hash, factoryAddress: tx.to as Address } });
        return;
      }
    }

    // 2. Fallback to swap detection
    const decoded = decodeSwapCalldata(tx.to as any, tx.input, this.knownPools, this.abiRegistry);
    if (!decoded) {
      if (this.knownPools.has(tx.to.toLowerCase())) {
        this.trackUnknownSelector(selector, tx.to, tx.hash);
      }
      this.logger.debug({ hash: tx.hash, selector }, "mempool: ignored tx (no decoded swap)");
      return;
    }

    // Dynamic Pool Learning: after successful decode, ensure the resolved pool is known
    if (!this.knownPools.has(decoded.poolAddress)) {
      this.logger.debug({ pool: decoded.poolAddress, selector }, "mempool: dynamically learned decoded pool");
      this.knownPools.add(decoded.poolAddress);
    }

    const overrideApplied = this.applyPendingOverride(decoded, tx.hash, tx);

    if (this.overlay && !overrideApplied) {
      const proto = decoded.protocol.toUpperCase();
      if (proto.startsWith("UNISWAP_V2")) {
        this.applyV2OverlayUpdate(decoded);
      }
    }

    const isIndirect = decoded.poolAddress.toLowerCase() !== (tx.to || "").toLowerCase();
    if (!isIndirect && decoded.amountIn < this.options.largeSwapThresholdWei) {
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

    const signal: LargeSwapSignal = {
      traceId,
      txHash: tx.hash,
      poolAddress: decoded.poolAddress,
      tokenIn: decoded.tokenIn,
      tokenOut: decoded.tokenOut,
      estimatedSwapSize: decoded.amountIn,
      zeroForOne: decoded.zeroForOne,
    };
    this.emit({ type: "large_swap", data: signal });
  }

  private applyV2OverlayUpdate(decoded: DecodedSwap): void {
    if (!this.overlay) return;

    const currentState = this.options.getPoolState?.(decoded.poolAddress.toLowerCase());
    const deltas = computeV2OverlayDeltas(decoded, currentState);
    if (!deltas) return;

    this.logger.debug(
      { pool: decoded.poolAddress, deltas: JSON.stringify(deltas, (_, v) => (typeof v === "bigint" ? v.toString() : v)) },
      "mempool: updating V2 overlay (fallback)",
    );

    this.overlay.update(decoded.poolAddress, deltas);
  }

  private applyPendingOverride(
    decoded: DecodedSwap,
    txHash: string,
    tx: { to: string; input: string; value: string },
  ): boolean {
    if (!this.pendingOverrideStore || !this.options.getPoolState) return false;

    const poolAddr = decoded.poolAddress.toLowerCase();
    const currentState = this.options.getPoolState(poolAddr);
    if (!currentState) return false;

    const amountIn = resolveSwapAmountIn(decoded, currentState);

    const override = buildStateOverride({
      poolAddress: decoded.poolAddress,
      protocol: decoded.protocol,
      tokenIn: decoded.tokenIn,
      tokenOut: decoded.tokenOut,
      amountIn,
      zeroForOne: decoded.zeroForOne,
      currentState,
    });
    if (!override) {
      if (this.options.mempoolSimulator) {
        void this.applyTraceOverride(decoded, amountIn, txHash, tx, poolAddr);
      }
      return false;
    }

    this.pendingOverrideStore.update(override, [poolAddr], txHash);
    this.options.invalidatePoolTicks?.(poolAddr);
    return true;
  }

  private async applyTraceOverride(
    decoded: DecodedSwap,
    amountIn: bigint,
    txHash: string,
    tx: { to: string; input: string; value: string },
    poolAddr: string,
  ): Promise<void> {
    const simulator = this.options.mempoolSimulator;
    if (!simulator || !this.pendingOverrideStore) return;

    try {
      const result = await simulator.buildOverride(
        decoded.poolAddress,
        decoded.protocol,
        decoded.tokenIn,
        decoded.tokenOut,
        amountIn,
        tx,
        { zeroForOne: decoded.zeroForOne },
      );
      if (!result.success || !result.stateOverride) {
        this.logger.debug({ txHash, error: result.error }, "mempool: trace override failed");
        return;
      }

      this.pendingOverrideStore.update(result.stateOverride, result.affectedPools, txHash);
      for (const pool of result.affectedPools) {
        this.options.invalidatePoolTicks?.(pool);
      }
      this.logger.debug({ txHash, method: result.method, pools: result.affectedPools.length }, "mempool: trace override applied");
    } catch (err) {
      this.logger.warn({ err, txHash }, "mempool: trace override error");
    }
  }

  private trackUnknownSelector(selector: string, to: string, hash: string): void {
    const now = new Date().toISOString();
    const existing = this.unknownSelectors.get(selector);
    if (existing) {
      existing.count++;
      existing.lastSeen = now;
    } else {
      this.unknownSelectors.set(selector, {
        selector,
        count: 1,
        sampleTx: hash,
        sampleTo: to,
        firstSeen: now,
        lastSeen: now,
      });
    }
    this.saveUnknownSelectors();
  }
}
