import { describe, it, expect, vi } from "vitest";
import {
  isValidPoolKey,
  parsePoolMetaRows,
  buildGraphQLListQuery,
  escapeGraphQLString,
  blockCursorWhere,
} from "./hyperindex_graphql.ts";

vi.mock("../garbage/garbage-tracker.ts", () => ({
  isGarbagePool: vi.fn().mockReturnValue(false),
  KNOWN_INDEXED_FACTORIES: new Set<string>(),
  markAsGarbage: vi.fn().mockResolvedValue(undefined),
}));

describe("buildGraphQLListQuery", () => {
  it("omits where clause without leaving a stray comma", () => {
    const query = buildGraphQLListQuery("PoolMeta", "id protocol", {
      limit: 100,
      orderBy: "[{ id: asc }]",
    });
    expect(query).toBe("{ PoolMeta(limit: 100, order_by: [{ id: asc }]) { id protocol } }");
    expect(query).not.toContain(", ,");
  });

  it("includes where clause when provided", () => {
    const query = buildGraphQLListQuery("V2PoolState", "id address", {
      limit: 50,
      where: "where: { lastUpdatedBlock: { _gt: 123 } }",
      orderBy: "[{ lastUpdatedBlock: asc }]",
    });
    expect(query).toContain("where: { lastUpdatedBlock: { _gt: 123 } }");
  });
});

describe("blockCursorWhere", () => {
  it("returns undefined for cold-start full scans", () => {
    expect(blockCursorWhere("createdBlock", 0, null, null)).toBeUndefined();
  });

  it("uses incremental filter after a checkpoint block", () => {
    expect(blockCursorWhere("lastUpdatedBlock", 42, null, null)).toBe(
      "where: { lastUpdatedBlock: { _gt: 42 } }",
    );
  });

  it("uses composite cursor for stable pagination", () => {
    expect(blockCursorWhere("createdBlock", 0, 100, "0xabc")).toContain('id: { _gt: "0xabc" }');
  });
});

describe("escapeGraphQLString", () => {
  it("escapes quotes and backslashes", () => {
    expect(escapeGraphQLString('0x"a\\b')).toBe('0x\\"a\\\\b');
  });
});

describe("isValidPoolKey", () => {
  it("accepts 20-byte addresses and 32-byte pool keys", () => {
    expect(isValidPoolKey("0x1234567890123456789012345678901234567890")).toBe(true);
    expect(isValidPoolKey("0xa86bf92b25f6565ebcb42d5f6af3005db22389c139344ef3e511b077875acd0c")).toBe(true);
    expect(isValidPoolKey("0xinvalid")).toBe(false);
    expect(isValidPoolKey("0x1234")).toBe(false);
  });
});

describe("parsePoolMetaRows", () => {
  it("keeps valid V2/V3 addresses and Uniswap V4 pool keys", () => {
    const rows = [
      {
        id: "0x1234567890123456789012345678901234567890",
        protocol: "UNISWAP_V3",
        tokens: '["0x1234567890123456789012345678901234567891", "0x1234567890123456789012345678901234567892"]',
        fee: 3000,
      },
      {
        id: "0xinvalidaddress",
        protocol: "UNISWAP_V3",
        tokens: '["0x1234567890123456789012345678901234567891", "0x1234567890123456789012345678901234567892"]',
        fee: 3000,
      },
      {
        id: "0xa86bf92b25f6565ebcb42d5f6af3005db22389c139344ef3e511b077875acd0c",
        protocol: "UNISWAP_V4",
        tokens: '["0x1234567890123456789012345678901234567891", "0x1234567890123456789012345678901234567892"]',
        fee: 3000,
      },
    ];

    const result = parsePoolMetaRows(rows);
    expect(result.length).toBe(2);
    expect(result.some((p) => p.protocol === "UNISWAP_V4")).toBe(true);
  });

  it("preserves Balancer poolId", () => {
    const rows = [
      {
        id: "0x1234567890123456789012345678901234567890",
        protocol: "BALANCER_V2",
        tokens: '["0xaaa", "0xbbb", "0xccc"]',
        fee: 30,
        poolId: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
    ];
    const result = parsePoolMetaRows(rows);
    expect(result[0]?.poolId).toBe(rows[0].poolId);
  });
});
