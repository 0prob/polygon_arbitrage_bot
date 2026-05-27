import { expect, test } from "vitest";
import { loadConfig } from "./loader.ts";

test("loadConfig maps all environment variables correctly", () => {
  const env = {
    ENVIO_API_TOKEN: "test-token",
    EXECUTION_RPC: "http://localhost:8545",
    EXECUTOR_ADDRESS: "0x1234567890123456789012345678901234567890",
    PRIVATE_KEY: "0x" + "a".repeat(64),
    CROSS_CHAIN_ARB_ENABLED: "true",
    KATANA_RPC_URL: "https://katana.test",
    ESCROW_AMOUNT: "5000000000000000000", // 5 ETH
    MIN_PROFIT_BPS: "50",
    MAX_SWAP_HOPS: "4",
  };

  const config = loadConfig(env);

  expect(config.envioApiToken).toBe("test-token");
  expect(config.crossChainArb?.enabled).toBe(true);
  expect(config.crossChainArb?.katanaRpcUrl).toBe("https://katana.test");
  expect(config.crossChainArb?.escrowAmount).toBe(5000000000000000000n);
  expect(config.crossChainArb?.minProfitBps).toBe(50);
  expect(config.crossChainArb?.maxSwapHops).toBe(4);
});
