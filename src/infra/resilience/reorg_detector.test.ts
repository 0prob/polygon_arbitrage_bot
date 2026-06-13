import { describe, it, expect, vi } from "vitest";
import { ReorgDetector, normalizeBlockHash } from "./reorg_detector.ts";
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

  it("normalizeBlockHash strips 0x prefix and lowercases", () => {
    expect(normalizeBlockHash("0xAbCdEf")).toBe("abcdef");
    expect(normalizeBlockHash("AbCdEf")).toBe("abcdef");
  });

  it("checkReorg treats 0x-prefixed and bare hashes as equal", async () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 1);
    await rd.trackBlock(100, "0xdeadbeef");
    const reorged = await rd.checkReorg({ number: 100, hash: "deadbeef" });
    expect(reorged.size).toBe(0);
  });

  it("trackBlock replaces existing height instead of duplicating", async () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 1);
    await rd.trackBlock(100, "0xaaa");
    await rd.trackBlock(100, "0xbbb");
    expect(rd.getTrackedBlocks()).toHaveLength(1);
    expect(rd.getTrackedBlocks()[0].hash).toBe("bbb");
  });

  it("checkLocalParentMismatch detects WS fork before trackBlock", async () => {
    const client = makeMockClient();
    const rd = new ReorgDetector(client, 2);
    await rd.trackBlock(99, "0xparent99");
    expect(rd.checkLocalParentMismatch(100, "0xwrongparent")).toBe(true);
    expect(rd.checkLocalParentMismatch(100, "0xparent99")).toBe(false);
    expect(rd.checkLocalParentMismatch(100, "")).toBe(false);
  });

  it("checkReorg detects hash mismatch and prunes stale tracked blocks", async () => {
    const client = {
      getBlock: vi.fn().mockImplementation(({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber === 99n) return Promise.resolve({ hash: "0xold99" });
        return Promise.resolve({ hash: "0xcanonical" });
      }),
    } as unknown as PublicClient;
    const rd = new ReorgDetector(client, 2);
    await rd.trackBlock(99, "0xold99");
    await rd.trackBlock(100, "0xold100");
    const reorged = await rd.checkReorg({ number: 100, hash: "0xcanonical" });
    expect(reorged.has(100)).toBe(true);
    expect(rd.getTrackedBlocks().some((b) => b.number === 100 && b.hash === "old100")).toBe(false);
    await rd.trackBlock(100, "0xcanonical");
    const again = await rd.checkReorg({ number: 100, hash: "0xcanonical" });
    expect(again.size).toBe(0);
  });
});
