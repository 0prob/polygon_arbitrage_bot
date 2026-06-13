import { describe, it, expect, vi } from "vitest";
import { ReceiptPoller } from "./receipt.ts";
import type { Logger } from "../../infra/observability/logger.ts";
import type { RpcManager } from "../../rpc/manager.ts";

describe("ReceiptPoller", () => {
  const logger = { debug: vi.fn(), error: vi.fn() } as unknown as Logger;

  it("sticks to the first successful receipt source", async () => {
    const hyperSyncReceipt = vi.fn().mockResolvedValue(null);
    const hyperRpcReceipt = vi.fn().mockResolvedValue({
      status: "0x1",
      gasUsed: 100n,
      logs: [],
    });
    const viemReceipt = vi.fn();

    const rpc = {
      hyperSync: { getTransactionReceipt: hyperSyncReceipt, getTransactionTraces: vi.fn().mockResolvedValue([]) },
      hyperRpc: { getTransactionReceipt: hyperRpcReceipt },
      read: { getTransactionReceipt: viemReceipt },
    } as unknown as RpcManager;

    const poller = new ReceiptPoller(logger, rpc, 5_000, 10);
    const receipt = await poller.wait("0xabc");

    expect(receipt?.status).toBe(true);
    expect(hyperSyncReceipt).toHaveBeenCalledTimes(1);
    expect(hyperRpcReceipt).toHaveBeenCalledTimes(1);
    expect(viemReceipt).not.toHaveBeenCalled();

    hyperSyncReceipt.mockClear();
    hyperRpcReceipt.mockClear();
    viemReceipt.mockClear();

    await poller.wait("0xdef");
    expect(hyperSyncReceipt).not.toHaveBeenCalled();
    expect(hyperRpcReceipt).toHaveBeenCalledTimes(1);
    expect(viemReceipt).not.toHaveBeenCalled();
  });
});
