import { expect, test } from "vitest";
import { loadConfig } from "./loader.ts";

test("loadConfig maps all environment variables correctly", () => {
  const env = {
    EXECUTION_RPC: "http://localhost/8545",
    EXECUTOR_ADDRESS: "0x1234567890123456789012345678901234567890",
    PRIVATE_KEY: "0x" + "a".repeat(64),
    V3_SHALLOW_MAX_IMPACT_BPS: "40",
    SYNC_HEAD_REFRESH_MAX_POOLS: "25",
    ORACLE_MAX_DIVERGENCE_BPS: "300",
    MEV_MAX_BID_BPS: "250",
    RANKING_MODE: "off",
    RANKING_MODEL_PATH: "data/custom-model.json",
  };

  const config = loadConfig(env);

  expect(config.envioApiToken).toBe(""); // optional, defaults to empty
  expect(config.rpc.executionRpcUrl).toBe("http://localhost/8545");
  expect(config.routing.v3ShallowMaxImpactBps).toBe(40);
  expect(config.sync.headRefreshMaxPools).toBe(25);
  expect(config.oracle.maxDivergenceBps).toBe(300);
  expect(config.mev.maxBidBps).toBe(250);
  expect(config.ranking.mode).toBe("off");
  expect(config.ranking.modelPath).toBe("data/custom-model.json");
});
