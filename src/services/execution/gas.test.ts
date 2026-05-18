import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GasOracle, DEFAULT_GAS_CONFIG, scalePriorityFeeByProfitMargin } from "./gas.ts";

describe("GasOracle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses Polygon-optimized default values", () => {
    expect(DEFAULT_GAS_CONFIG.pollIntervalMs).toBe(1000);
    expect(DEFAULT_GAS_CONFIG.priorityFeeFloorGwei).toBe(1);
    expect(DEFAULT_GAS_CONFIG.priorityFeeCeilingGwei).toBe(50);
    expect(DEFAULT_GAS_CONFIG.maxBidMultiplier).toBe(3);
  });

  it("returns null snapshot before start", () => {
    const oracle = new GasOracle(DEFAULT_GAS_CONFIG, () => Promise.resolve({ baseFee: 30n * 10n ** 9n, priorityFee: 1n * 10n ** 9n }));
    expect(oracle.getSnapshot()).toBeNull();
  });

  it("fetches gas on start and caches snapshot", async () => {
    const fetchGas = vi.fn().mockResolvedValue({ baseFee: 40n * 10n ** 9n, priorityFee: 35n * 10n ** 9n });
    const oracle = new GasOracle(DEFAULT_GAS_CONFIG, fetchGas);
    await oracle.start();
    const snap = oracle.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.baseFee).toBe(40n * 10n ** 9n);
    expect(snap!.priorityFee).toBe(35n * 10n ** 9n);
    expect(snap!.maxFee).toBe(40n * 10n ** 9n * 2n + 35n * 10n ** 9n);
    expect(snap!.gasPrice).toBe(40n * 10n ** 9n + 35n * 10n ** 9n);
    expect(typeof snap!.timestamp).toBe("number");
    expect(fetchGas).toHaveBeenCalledTimes(1);
    oracle.stop();
  });

  it("clamps priority fee to configured floor", async () => {
    // priorityFee = 0.5 gwei, floor = 1 gwei
    const fetchGas = vi.fn().mockResolvedValue({ baseFee: 50n * 10n ** 9n, priorityFee: 5n * 10n ** 8n });
    const oracle = new GasOracle(DEFAULT_GAS_CONFIG, fetchGas);
    await oracle.start();
    const snap = oracle.getSnapshot();
    expect(snap!.priorityFee).toBe(1n * 10n ** 9n);
    oracle.stop();
  });

  it("clamps priority fee to configured ceiling", async () => {
    const fetchGas = vi.fn().mockResolvedValue({ baseFee: 50n * 10n ** 9n, priorityFee: 100n * 10n ** 9n });
    const oracle = new GasOracle(DEFAULT_GAS_CONFIG, fetchGas);
    await oracle.start();
    const snap = oracle.getSnapshot();
    expect(snap!.priorityFee).toBe(50n * 10n ** 9n);
    oracle.stop();
  });

  it("keeps last snapshot on fetch failure", async () => {
    const fetchGas = vi.fn()
      .mockResolvedValueOnce({ baseFee: 30n * 10n ** 9n, priorityFee: 30n * 10n ** 9n })
      .mockRejectedValueOnce(new Error("RPC error"));
    const oracle = new GasOracle({ ...DEFAULT_GAS_CONFIG, pollIntervalMs: 100 }, fetchGas);
    await oracle.start();
    const first = oracle.getSnapshot();
    expect(first).not.toBeNull();
    // Trigger a refresh cycle
    vi.advanceTimersByTime(100);
    // Wait for the rejected promise to settle
    await vi.advanceTimersByTimeAsync(0);
    const second = oracle.getSnapshot();
    expect(second!.baseFee).toBe(first!.baseFee);
    expect(second!.priorityFee).toBe(first!.priorityFee);
    oracle.stop();
  });

  it("stop clears interval", async () => {
    const fetchGas = vi.fn().mockResolvedValue({ baseFee: 30n * 10n ** 9n, priorityFee: 30n * 10n ** 9n });
    const oracle = new GasOracle({ ...DEFAULT_GAS_CONFIG, pollIntervalMs: 50 }, fetchGas);
    await oracle.start();
    oracle.stop();
    const countBefore = fetchGas.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(fetchGas.mock.calls.length).toBe(countBefore);
  });

  describe("estimateCongestion", () => {
    it("returns neutral hints when no snapshot exists", () => {
      const oracle = new GasOracle(DEFAULT_GAS_CONFIG, () => Promise.resolve({ baseFee: 1n, priorityFee: 1n }));
      const hints = oracle.estimateCongestion();
      expect(hints.congestion).toBe(0);
      expect(hints.recommendedPriorityFee).toBe(0n);
      expect(hints.isSpiking).toBe(false);
    });

    it("returns neutral hints with insufficient history (< 2)", async () => {
      const fetchGas = vi.fn().mockResolvedValue({ baseFee: 50n * 10n ** 9n, priorityFee: 10n * 10n ** 9n });
      const oracle = new GasOracle(DEFAULT_GAS_CONFIG, fetchGas);
      await oracle.start();
      const hints = oracle.estimateCongestion();
      expect(hints.congestion).toBe(0);
      expect(hints.isSpiking).toBe(false);
      oracle.stop();
    });

    it("returns low congestion when base fees are stable", async () => {
      const fetchGas = vi.fn().mockResolvedValue({ baseFee: 50n * 10n ** 9n, priorityFee: 2n * 10n ** 9n });
      const oracle = new GasOracle({ ...DEFAULT_GAS_CONFIG, pollIntervalMs: 50 }, fetchGas);
      await oracle.start();
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(50);
        await vi.advanceTimersByTimeAsync(0);
      }
      const hints = oracle.estimateCongestion();
      expect(hints.congestion).toBe(0);
      expect(hints.isSpiking).toBe(false);
      oracle.stop();
    });

    it("detects gas spike when base fee jumps > 1.5x average", async () => {
      let callCount = 0;
      const fetchGas = vi.fn().mockImplementation(() => {
        callCount++;
        const baseFee = callCount <= 8 ? 50n * 10n ** 9n : 200n * 10n ** 9n;
        return Promise.resolve({ baseFee, priorityFee: 2n * 10n ** 9n });
      });
      const oracle = new GasOracle({ ...DEFAULT_GAS_CONFIG, pollIntervalMs: 50 }, fetchGas);
      await oracle.start();
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(50);
        await vi.advanceTimersByTimeAsync(0);
      }
      const hints = oracle.estimateCongestion();
      expect(hints.isSpiking).toBe(true);
      expect(hints.congestion).toBeGreaterThan(0);
      expect(hints.recommendedPriorityFee).toBeGreaterThan(0n);
      oracle.stop();
    });
  });
});

describe("scalePriorityFeeByProfitMargin", () => {
  it("returns scaled priority fee based on profit margin", () => {
    const fee = 30n * 10n ** 9n;
    const scaled = scalePriorityFeeByProfitMargin(fee, 500n, 5);
    expect(scaled).toBe(fee * 5n);
  });

  it("does not go below 1x multiplier", () => {
    const fee = 30n * 10n ** 9n;
    const scaled = scalePriorityFeeByProfitMargin(fee, 0n, 5);
    expect(scaled).toBe(fee);
  });

  it("caps at maxMultiplier", () => {
    const fee = 30n * 10n ** 9n;
    const scaled = scalePriorityFeeByProfitMargin(fee, 2000n, 3);
    expect(scaled).toBe(fee * 3n);
  });
});
