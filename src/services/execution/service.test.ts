import { describe, it, expect, vi } from "vitest";
import { padHex, getAddress } from "viem";
import { ExecutionService, parseTransferLogs } from "./service.ts";
import { SubmissionStrategy } from "./submit.ts";
import { ReceiptPoller } from "./receipt.ts";
import type { Logger } from "../../infra/observability/logger.ts";
import type { GasOracle } from "./gas.ts";
import type { NonceManager } from "./nonce.ts";
import type { RpcManager } from "../../rpc/manager.ts";

describe("ExecutionService", () => {
  const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const mockGasOracle = {
    start: vi.fn(),
    stop: vi.fn(),
    getSnapshot: vi.fn(),
    config: undefined,
    getPredictedBaseFee: vi.fn(),
  } as unknown as GasOracle;
  const mockNonceManager = {
    initialize: vi.fn(),
    getNextNonce: vi.fn(),
    confirmNonce: vi.fn(),
    markInFlight: vi.fn(),
    markStale: vi.fn(),
    resync: vi.fn(),
  } as unknown as NonceManager;
  const mockSubmitTx = vi.fn();
  const mockRpc = { read: { getTransactionReceipt: vi.fn() } } as unknown as RpcManager;

  const makeService = () => {
    const strategy = new SubmissionStrategy(mockLogger, mockGasOracle, [mockSubmitTx], {});
    const poller = new ReceiptPoller(mockLogger, mockRpc, 30_000, 500);
    return new ExecutionService(mockLogger, strategy, poller, mockGasOracle, mockNonceManager);
  };

  it("quarantines route on gas data failure", async () => {
    const service = makeService();

    vi.spyOn(mockGasOracle, "getSnapshot").mockReturnValue(null);

    const candidate = {
      routeKey: "test-route-gas",
      calldata: "0x",
      targetAddress: "0x123",
      value: 0n,
    };

    const result = await service.execute(candidate);

    expect(result.success).toBe(false);
    expect(result.error).toBe("no gas data");
    expect(service.isQuarantined("test-route-gas")).toBe(false);
  });

  it("quarantines route on execution failure", async () => {
    const service = makeService();

    vi.spyOn(mockGasOracle, "getSnapshot").mockReturnValue({
      baseFee: 100n,
      priorityFee: 10n,
      maxFee: 110n,
      gasPrice: 110n,
      timestamp: Date.now(),
    });
    vi.spyOn(mockNonceManager, "getNextNonce").mockReturnValue(1);
    mockSubmitTx.mockRejectedValue(new Error("tx failed"));

    const candidate = {
      routeKey: "test-route-execution",
      calldata: "0x",
      targetAddress: "0x123",
      value: 0n,
    };

    const result = await service.execute(candidate);

    expect(result.success).toBe(false);
    expect(result.error).toBe("tx failed");
    expect(service.isQuarantined("test-route-execution")).toBe(true);
  });

  it("computes net ERC20 profit for the executor", () => {
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const executor = getAddress("0x00000000000000000000000000000000000000Ee");
    const other = getAddress("0x00000000000000000000000000000000000000Aa");

    const logs = [
      {
        topics: [transferTopic, padHex(other, { size: 32 }), padHex(executor, { size: 32 })],
        data: "0x0000000000000000000000000000000000000000000000000000000000000064",
      },
      {
        topics: [transferTopic, padHex(executor, { size: 32 }), padHex(other, { size: 32 })],
        data: "0x000000000000000000000000000000000000000000000000000000000000001e",
      },
    ];

    expect(parseTransferLogs(logs, executor)).toBe(70n);
  });

  it("reserves and confirms external nonce on MEV confirm path", async () => {
    const service = makeService();
    vi.spyOn(mockNonceManager, "getNextNonce").mockReturnValue(7);
    expect(service.reserveExternalNonce()).toBe(7);
    expect(mockNonceManager.markInFlight).toHaveBeenCalledWith(7);

    service.confirmExternalNonce(7);
    expect(mockNonceManager.confirmNonce).toHaveBeenCalledWith(7);

    service.releaseExternalNonce(8);
    expect(mockNonceManager.markStale).toHaveBeenCalledWith(8);
  });
});
