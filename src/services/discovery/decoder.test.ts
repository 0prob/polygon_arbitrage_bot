import { describe, it, expect } from "vitest";
import { decodePairCreated, decodePoolRegistered, decodePoolDeployed } from "./decoder.ts";
import type { HyperSyncLog } from "../../infra/hypersync/types.ts";

describe("decodePairCreated", () => {
  it("decodes V2 pair event with token0, token1, pair address", () => {
    const log: HyperSyncLog = {
      address: "0xfactory",
      blockNumber: 1000, topics: [
        "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
        "0x0000000000000000000000000d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
        "0x0000000000000000000000007ceb23fd6bc0add59e62ac25578270cff1b9f619",
      ],
      data: "0x000000000000000000000000aabbccdd1234567890abcdef1234567890abcdef",
      txHash: "0xtx", logIndex: 0, txIndex: 0,
    };
    const r = decodePairCreated(log);
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("UNISWAP_V2");
    expect(r!.poolAddress.toLowerCase()).toContain("aabbccdd");
  });
  it("returns null for too few topics", () => {
    expect(decodePairCreated({ topics: ["0xabc"] } as HyperSyncLog)).toBeNull();
  });
});

describe("decodePoolRegistered", () => {
  it("decodes Balancer pool", () => {
    const r = decodePoolRegistered({
      topics: ["0xabc", "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    } as HyperSyncLog);
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("BALANCER_V2");
  });
});

describe("decodePoolDeployed", () => {
  it("decodes V3 style pool creation", () => {
    const r = decodePoolDeployed({
      topics: ["0xabc", "0x" + "00".repeat(12) + "aa".repeat(20), "0x" + "00".repeat(12) + "bb".repeat(20), "0x" + "00".repeat(12) + "cc".repeat(20)],
    } as HyperSyncLog);
    expect(r).not.toBeNull();
    expect(r!.protocol).toBe("QUICKSWAP_V3");
  });
});
