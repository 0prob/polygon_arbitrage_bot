import { describe, it, expect } from "vitest";
import { buildLogQuery, normalizeLogFilter, computeTopic0, computeTopic0s } from "./query.ts";
import type { HyperSyncLogFilter } from "./types.ts";

describe("buildLogQuery", () => {
  it("builds query from basic filters with fromBlock", () => {
    const filters: HyperSyncLogFilter[] = [{ address: ["0x1234567890abcdef1234567890abcdef12345678"] }];
    const query = buildLogQuery(filters, 1000);
    expect(query.fromBlock).toBe(1000);
    expect(query.toBlock).toBeUndefined();
    expect(query.logs).toHaveLength(1);
    expect(query.logs[0].address).toEqual(["0x1234567890abcdef1234567890abcdef12345678"]);
  });

  it("builds query with toBlock", () => {
    const filters: HyperSyncLogFilter[] = [{ address: ["0x1234567890abcdef1234567890abcdef12345678"] }];
    const query = buildLogQuery(filters, 1000, 2000);
    expect(query.fromBlock).toBe(1000);
    expect(query.toBlock).toBe(2000);
  });

  it("includes default field selection", () => {
    const filters: HyperSyncLogFilter[] = [{ address: ["0x1234567890abcdef1234567890abcdef12345678"] }];
    const query = buildLogQuery(filters, 1000);
    expect(query.fieldSelection.log).toBeDefined();
    expect(query.fieldSelection.block).toBeDefined();
    expect(Array.isArray(query.fieldSelection.log)).toBe(true);
    expect(query.fieldSelection.log.length).toBeGreaterThan(0);
    expect(Array.isArray(query.fieldSelection.block)).toBe(true);
    expect(query.fieldSelection.block.length).toBeGreaterThan(0);
  });

  it("builds query with multiple log filters", () => {
    const filters: HyperSyncLogFilter[] = [
      { address: ["0x1111111111111111111111111111111111111111"] },
      { address: ["0x2222222222222222222222222222222222222222"] },
    ];
    const query = buildLogQuery(filters, 100);
    expect(query.logs).toHaveLength(2);
    expect(query.logs[0].address![0]).toBe("0x1111111111111111111111111111111111111111");
    expect(query.logs[1].address![0]).toBe("0x2222222222222222222222222222222222222222");
  });
});

describe("normalizeLogFilter", () => {
  it("deduplicates addresses", () => {
    const filter: HyperSyncLogFilter = {
      address: ["0x1234567890abcdef1234567890abcdef12345678", "0x1234567890abcdef1234567890abcdef12345678"],
    };
    const result = normalizeLogFilter(filter);
    expect(result.address).toHaveLength(1);
    expect(result.address![0]).toBe("0x1234567890abcdef1234567890abcdef12345678");
  });

  it("trims unconstrained trailing topics", () => {
    const filter: HyperSyncLogFilter = {
      address: ["0x1234567890abcdef1234567890abcdef12345678"],
      topics: [["0x0000000000000000000000000000000000000000000000000000000000000001"], [], []],
    };
    const result = normalizeLogFilter(filter);
    expect(result.topics).toHaveLength(1);
    expect(result.topics![0]).toHaveLength(1);
    expect(result.topics![0][0]).toBe("0x0000000000000000000000000000000000000000000000000000000000000001");
  });

  it("lowercases addresses", () => {
    const filter: HyperSyncLogFilter = {
      address: ["0xABCdef1234567890abcDEF1234567890abcdEF12"],
    };
    const result = normalizeLogFilter(filter);
    expect(result.address![0]).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
  });

  it("preserves filter when no topics provided", () => {
    const filter: HyperSyncLogFilter = {
      address: ["0x1234567890abcdef1234567890abcdef12345678"],
    };
    const result = normalizeLogFilter(filter);
    expect(result.address).toHaveLength(1);
    expect(result.topics).toBeUndefined();
  });
});

describe("computeTopic0", () => {
  it("produces deterministic hex for Transfer event", () => {
    const topic0 = computeTopic0("event Transfer(address indexed from, address indexed to, uint256 value)");
    expect(topic0).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("auto-prepends event prefix", () => {
    const topic0 = computeTopic0("Transfer(address indexed from, address indexed to, uint256 value)");
    expect(topic0).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("returns empty string for invalid signature", () => {
    const topic0 = computeTopic0("invalid signature");
    expect(topic0).toBe("");
  });

  it("caches computed topic0s", () => {
    const sig = "event Transfer(address indexed from, address indexed to, uint256 value)";
    const first = computeTopic0(sig);
    const second = computeTopic0(sig);
    expect(first).toBe(second);
    expect(first).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });
});

describe("computeTopic0s", () => {
  it("computes multiple topic0s", () => {
    const topics = computeTopic0s([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
      "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
    ]);
    expect(topics).toHaveLength(2);
    expect(topics[0]).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(topics[1]).toBe("0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822");
  });

  it("handles empty array", () => {
    expect(computeTopic0s([])).toEqual([]);
  });
});
