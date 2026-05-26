import { describe, it, expect, vi } from "vitest";
import { ReorgDetector } from "./reorg_detector.ts";
import type { PublicClient } from "viem";

function makeMockClient(): PublicClient {
  const block = vi.fn().mockRejectedValue(new Error("not found"));
  return {
    getBlock: block,
  } as unknown as PublicClient;
}

describe("ReorgDetector", () => {
  it("starts with no tracked blocks", () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 10);
    expect(rd.getTrackedBlocks()).toHaveLength(0);
    expect(rd.getLastSafeBlock()).toBe(0);
  });

  it("tracks blocks", async () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 10);
    await rd.trackBlock(1, "0xhash1");
    await rd.trackBlock(2, "0xhash2");
    expect(rd.getTrackedBlocks()).toHaveLength(2);
    expect(rd.getTrackedBlocks()[0].number).toBe(1);
    expect(rd.getTrackedBlocks()[1].number).toBe(2);
  });

  it("prunes old blocks", async () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 10);
    await rd.trackBlock(1, "0xhash1");
    await new Promise((r) => setTimeout(r, 10));
    const before = rd.getTrackedBlocks().length;
    await rd.trackBlock(2, "0xhash2");
    rd.prune(5); // prune blocks older than 5ms
    expect(rd.getTrackedBlocks().length).toBeLessThanOrEqual(before);
  });

  it("clears reorged blocks", () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 10);
    expect(rd.isBlockReorged(1)).toBe(false);
    rd.clearReorged();
  });

  it("checkReorg returns empty set with no blocks", async () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 10);
    const result = await rd.checkReorg();
    expect(result.size).toBe(0);
  });
});
