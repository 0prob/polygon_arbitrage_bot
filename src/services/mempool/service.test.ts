import { describe, it, expect, vi } from "vitest";
import { MempoolService } from "./service.ts";
import type { MempoolSignal } from "./signals.ts";
import type { Logger } from "../../infra/observability/logger.ts";
import { encodeFunctionData } from "viem";
import { UNISWAP_V2_POOL_ABI, UNISWAP_V3_POOL_ABI, UNISWAP_V2_FACTORY_ABI } from "../../core/abis/compiled/index.ts";

describe("MempoolService", () => {
  it("emits large_swap signal for matching V2 swap", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n });
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
    const service = new MempoolService(logger, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n });
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

  it("emits large_swap for generic indirect swap (heuristic)", () => {
    const signals: MempoolSignal[] = [];
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const service = new MempoolService(logger, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n });
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
    const service = new MempoolService(logger, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n });
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
    const service = new MempoolService(logger, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n });
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

  it("updates overlay for V2 swap", () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const overlay = {
      update: vi.fn(),
      get: vi.fn(),
      getProjected: vi.fn(),
      clear: vi.fn(),
    };
    const service = new MempoolService(logger, { coalesceTtlMs: 100, largeSwapThresholdWei: 1n }, overlay);
    service.setKnownPools(["0xpool1"]);

    // V2 swap: pool sends 10 of token1, so it received token0.
    const input = encodeFunctionData({
      abi: UNISWAP_V2_POOL_ABI,
      functionName: "swap",
      args: [0n, 10n, "0x0000000000000000000000000000000000000000", "0x"],
    });
    const tx = {
      hash: "0xabc",
      to: "0xpool1",
      input,
      value: "0x0",
    };
    service.processPendingTx(tx);
    expect(overlay.update).toHaveBeenCalledWith("0xpool1", { reserve0: 10n });
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
        coalesceTtlMs: 100,
        largeSwapThresholdWei: 1n,
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
});
