import { expect, test } from "vitest";
import { loadConfig } from "./loader.ts";

test("loadConfig maps all environment variables correctly", () => {
  const env = {
    EXECUTION_RPC: "http://localhost/8545",
    EXECUTOR_ADDRESS: "0x1234567890123456789012345678901234567890",
    PRIVATE_KEY: "0x" + "a".repeat(64),
  };

  const config = loadConfig(env);

  expect(config.envioApiToken).toBe(""); // optional, defaults to empty
  expect(config.rpc.executionRpcUrl).toBe("http://localhost/8545");
});
