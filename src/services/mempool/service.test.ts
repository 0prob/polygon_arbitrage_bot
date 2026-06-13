import { describe, it, expect, vi } from "vitest";
import { MempoolService } from "./service.ts";
import { PendingOverrideStore } from "./pending-override.ts";
import { resolveV2Fee, simulateV2Swap } from "../../core/math/uniswap_v2.ts";
import type { MempoolSignal } from "./signals.ts";
import type { Logger } from "../../infra/observability/logger.ts";
import { encodeFunctionData } from "viem";
import { UNISWAP_V2_POOL_ABI, UNISWAP_V3_POOL_ABI, UNISWAP_V2_FACTORY_ABI } from "../../core/abis/compiled/index.ts";
import { SwapUsdValuator } from "./swap_usd_valuation.ts";

const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";

function mempoolTestOptions(thresholdUsd = 0) {
  return {
    coalesceTtlMs: 100,
    largeSwapThresholdUsd: thresholdUsd,
    swapUsdValuator: new SwapUsdValuator(thresholdUsd),
  };
}

describe("MempoolService", () => {
  it("emits large_swap signal for matching V2 swap", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, mempoolTestOptions());
    service.setKnownPools(["0xpool1"]);
    service.onSignal((s) => signals.push(s));

    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [100n, 0n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    const tx = {
      hash: "0xabc",
      to: "0xpool1",
      input,
      value: "0x0",
    };
    service.processPendingTx(tx);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect((signals[0].data as any).traceId).toBe("tx-abc");
  });

  it("emits large_swap for V3 direct swap", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, mempoolTestOptions());
    service.setKnownPools(["0xpoolv3"]);
    service.onSignal((s) => signals.push(s));

    const input = encodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "swap",
      args: ["0x0000000000000000000000000000000000000000", true, 10n, 0n, "0x"],
    });
    const tx = {
      hash: "0xabc",
      to: "0xpoolv3",
      input,
      value: "0x0",
    };
    service.processPendingTx(tx);
    expect(signals.length).toBe(1);
    expect((signals[0] as any).data.estimatedSwapSize).toBe(10n);
  });

  it("filters direct swaps below USD threshold using token decimals and price", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const valuator = new SwapUsdValuator(10_000);
    valuator.update({
      tokenDecimals: new Map([[USDC, 6]]),
      tokenUsd: new Map([[USDC, 1]]),
      poolMetas: [{ address: "0xpoolusdc", token0: USDC, token1: WMATIC }],
    });
    const service = new MempoolService(logger, {
      coalesceTtlMs: 100,
      largeSwapThresholdUsd: 10_000,
      swapUsdValuator: valuator,
    });
    service.setKnownPools(["0xpoolusdc"]);
    service.onSignal((s) => signals.push(s));

    const small = encodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "swap",
      args: ["0x0000000000000000000000000000000000000000", true, 500n * 10n ** 6n, 0n, "0x"],
    });
    service.processPendingTx({ hash: "0xsmall", to: "0xpoolusdc", input: small, value: "0x0" });
    expect(signals.length).toBe(0);

    const large = encodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "swap",
      args: ["0x0000000000000000000000000000000000000000", true, 15_000n * 10n ** 6n, 0n, "0x"],
    });
    service.processPendingTx({ hash: "0xlarge", to: "0xpoolusdc", input: large, value: "0x0" });
    expect(signals.length).toBe(1);
    expect((signals[0] as any).data.estimatedSwapSize).toBe(15_000n * 10n ** 6n);
  });

  it("emits large_swap for generic indirect swap (heuristic)", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, mempoolTestOptions());
    const poolAddr = "0x" + "a".repeat(40);
    service.setKnownPools([poolAddr]);
    service.onSignal((s) => signals.push(s));

    const input = encodeFunctionData({
      abi: UNISWAP_V3_POOL_ABI,
      functionName: "swap",
      args: [poolAddr, true, 1n, 0n, "0x"],
    });
    const tx = {
      hash: "0xabc",
      to: "0xrouter",
      input,
      value: "0x0",
    };
    service.processPendingTx(tx);
    expect(signals.length).toBe(1);
    expect((signals[0] as any).data.poolAddress.toLowerCase()).toBe(poolAddr);
    expect((signals[0] as any).data.estimatedSwapSize).toBe(1n);
  });

  it("does not emit for unknown pool", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, mempoolTestOptions());
    service.onSignal((s) => signals.push(s));

    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [0n, 0n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    service.processPendingTx({ hash: "0xabc", to: "0xunknown", input, value: "0x0" });
    expect(signals.length).toBe(0);
  });

  it("emits new_pool_pending with traceId", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, mempoolTestOptions());
    service.onSignal((s) => signals.push(s));

    const input = encodeFunctionData({
      abi: UNISWAP_V2_FACTORY_ABI,
      functionName: "createPair",
      args: ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"],
    });
    const tx = {
      hash: "0x1234567890",
      to: "0xfactory",
      input,
      value: "0x0",
    };
    service.processPendingTx(tx);
    expect(signals.length).toBe(1);
    expect(signals[0].type).toBe("new_pool_pending");
    expect((signals[0].data as any).traceId).toBe("tx-123456");
  });

  it("updates overlay for V2 swap with reserve-aware input estimate", () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const overlay = {
      update: vi.fn(),
      get: vi.fn(),
      getProjected: vi.fn(),
      clear: vi.fn(),
    };
    const service = new MempoolService(
      logger,
      {
        ...mempoolTestOptions(),
        getPoolState: () => ({ reserve0: 1_000_000n, reserve1: 2_000_000n, initialized: true }),
      },
      overlay,
    );
    service.setKnownPools(["0xpool1"]);

    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [0n, 10n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    service.processPendingTx({ hash: "0xabc", to: "0xpool1", input, value: "0x0" });

    const state = { reserve0: 1_000_000n, reserve1: 2_000_000n, initialized: true };
    const amountIn = 6n;
    const { numerator, denominator } = resolveV2Fee(state, undefined, 1000n);
    const swap = simulateV2Swap(state, amountIn, true, numerator, denominator);

    // Override store is wired in production; without it, overlay is the fallback.
    expect(overlay.update).toHaveBeenCalledWith("0xpool1", { reserve0: amountIn, reserve1: -swap.amountOut });
  });

  it("skips overlay when pending override store succeeds", () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const overlay = {
      update: vi.fn(),
      get: vi.fn(),
      getProjected: vi.fn(),
      clear: vi.fn(),
    };
    const store = new PendingOverrideStore({ ttlMs: 60_000 });
    const service = new MempoolService(
      logger,
      {
        ...mempoolTestOptions(),
        getPoolState: () => ({ reserve0: 1_000_000n, reserve1: 2_000_000n, initialized: true }),
      },
      overlay,
      store,
    );
    service.setKnownPools(["0xpool1"]);

    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [0n, 10n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    service.processPendingTx({ hash: "0xabc", to: "0xpool1", input, value: "0x0" });

    expect(store.hasActive()).toBe(true);
    expect(overlay.update).not.toHaveBeenCalled();
  });

  it("updates overlay for V2 swap without pool state falls back to output amount", () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const overlay = {
      update: vi.fn(),
      get: vi.fn(),
      getProjected: vi.fn(),
      clear: vi.fn(),
    };
    const service = new MempoolService(logger, mempoolTestOptions(), overlay);
    service.setKnownPools(["0xpool1"]);

    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [0n, 10n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    service.processPendingTx({ hash: "0xabc", to: "0xpool1", input, value: "0x0" });
    expect(overlay.update).toHaveBeenCalledWith("0xpool1", { reserve0: 10n });
  });

  it("schedules trace override when manual build fails and simulator is configured", async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const store = new PendingOverrideStore({ ttlMs: 60_000 });
    const simulator = {
      buildOverride: vi.fn().mockResolvedValue({
        success: true,
        stateOverride: {
          "0xpool1": {
            stateDiff: {
              "0x0000000000000000000000000000000000000000000000000000000000000008": "0x64",
            },
          },
        },
        affectedPools: ["0xpool1"],
        method: "trace",
      }),
    };
    const service = new MempoolService(
      logger,
      {
        ...mempoolTestOptions(),
        getPoolState: () => ({ reserve0: 0n, reserve1: 0n, initialized: true }),
        mempoolSimulator: simulator as any,
      },
      undefined,
      store,
    );
    service.setKnownPools(["0xpool1"]);

    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [0n, 10n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    service.processPendingTx({ hash: "0xabc", to: "0xpool1", input, value: "0x0" });

    await vi.waitFor(() => expect(simulator.buildOverride).toHaveBeenCalled());
    expect(store.hasActive()).toBe(true);
  });

  it("tracks unknown selectors and saves them to a file", async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const fs = await import("node:fs");
    const testDir = "./data/test-mempool";
    const filePath = `${testDir}/unknown-selectors.json`;

    // Ensure clean state before running
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (fs.existsSync(testDir)) {
      fs.rmdirSync(testDir);
    }
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const service = new MempoolService(logger, {
        ...mempoolTestOptions(),
        dataDir: testDir,
      });

      await service.start();
      service.setKnownPools(["0xunknownpool"]);

      // Process a tx with an unknown selector (not ignored, not in SELECTORS)
      const unknownSelector = "0x99999999";
      service.processPendingTx({
        hash: "0xunknownhash",
        to: "0xunknownpool",
        input: unknownSelector + "0".repeat(64),
        value: "0x0",
      });

      // Stop to force flushing changes to disk
      await service.stop();

      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(content[unknownSelector]).toBeDefined();
      expect(content[unknownSelector].selector).toBe(unknownSelector);
      expect(content[unknownSelector].count).toBe(1);
      expect(content[unknownSelector].sampleTx).toBe("0xunknownhash");
    } finally {
      // Clean up
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      if (fs.existsSync(testDir)) {
        fs.rmdirSync(testDir);
      }
    }
  });

  it("updates known pools when set changes but length and first pool stay the same", () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, mempoolTestOptions());
    service.setKnownPools(["0xpool1", "0xpool2"]);
    const debugBefore = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.length;
    service.setKnownPools(["0xpool1", "0xpool3"]);
    const debugAfter = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(debugAfter).toBeGreaterThan(debugBefore);
  });
});
