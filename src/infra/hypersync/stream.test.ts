import { describe, it, expect, vi } from "vitest";
import { fetchAllLogs } from "./stream.ts";
import type { HypersyncClientRuntime, HyperSyncQuery } from "./types.ts";

describe("fetchAllLogs", () => {
  describe("Streaming Path", () => {
    it("should handle the streaming path correctly", async () => {
      const mockClient: HypersyncClientRuntime = {
        get: vi.fn(),
        stream: vi.fn().mockResolvedValue({
          recv: vi.fn()
            .mockResolvedValueOnce({ nextBlock: 1001, data: { logs: [{ id: "log1" }] } })
            .mockResolvedValueOnce({ nextBlock: 1002, data: { logs: [{ id: "log2" }] } })
            .mockResolvedValue(null),
        }),
      } as any;

      const query: HyperSyncQuery = {
        fromBlock: 1000,
        logs: [{ address: ["0x0000000000000000000000000000000000000000"] }],
        fieldSelection: { log: [], block: [] },
        joinMode: 0,
        maxNumLogs: 1000,
      };

      const result = await fetchAllLogs(mockClient, query);

      expect(result.logs.length).toBe(2);
      expect(result.nextBlock).toBe(1002);
      expect(mockClient.stream).toHaveBeenCalled();
      expect(mockClient.get).not.toHaveBeenCalled();
    });
  });

  describe("Pagination Path (client.get)", () => {
    it("should not get stuck in an infinite loop if nextBlock stalls", async () => {
      // This client does not have the `.stream` method, forcing the pagination path.
      const mockClient = {
        get: vi.fn()
          .mockResolvedValueOnce({ nextBlock: 1100, data: { logs: [] } }) // Progresses once
          .mockResolvedValue({ nextBlock: 1100, data: { logs: [] } }),    // Then stalls
      } as any;

      const query: HyperSyncQuery = {
        fromBlock: 1000,
        toBlock: 2000,
        logs: [{ address: ["0x0000000000000000000000000000000000000000"] }],
        fieldSelection: { log: [], block: [] },
        joinMode: 0,
        maxNumLogs: 1000,
      };

      // With the fix, this should resolve quickly. Without it, it will time out.
      const result = await fetchAllLogs(mockClient, query);
      
      // It should have made progress on the first call, then detected the stall and exited.
      expect(result.nextBlock).toBe(1100);
      expect(result.pages).toBe(2); // Ran twice before detecting the stall
      expect(mockClient.get).toHaveBeenCalledTimes(2);
    });
  });
});
