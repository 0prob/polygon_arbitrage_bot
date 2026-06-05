import { describe, it, expect, vi } from "vitest";
import { parsePoolMetaRows } from "./hyperindex_graphql";

vi.mock("../../core/constants.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/constants.ts")>();
  return {
    ...actual,
    isGarbagePool: vi.fn().mockReturnValue(false),
  };
});

describe("parsePoolMetaRows", () => {
  it("should filter out invalid addresses and keep valid ones", () => {
    const rows = [
      {
        id: "0x1234567890123456789012345678901234567890", // Valid
        protocol: "v3",
        tokens: '["0x1234567890123456789012345678901234567891", "0x1234567890123456789012345678901234567892"]',
        fee: 3000,
      },
      {
        id: "0xinvalidaddress", // Invalid
        protocol: "v3",
        tokens: '["0x1234567890123456789012345678901234567891", "0x1234567890123456789012345678901234567892"]',
        fee: 3000,
      },
      {
        id: "0xa86bf92b25f6565ebcb42d5f6af3005db22389c139344ef3e511b077875acd0c", // Too long (66 chars)
        protocol: "v3",
        tokens: '["0x1234567890123456789012345678901234567891", "0x1234567890123456789012345678901234567892"]',
        fee: 3000,
      },
    ];

    const result = parsePoolMetaRows(rows);
    expect(result.length).toBe(1);
    expect(result[0].address).toBe("0x1234567890123456789012345678901234567890");
  });
});
