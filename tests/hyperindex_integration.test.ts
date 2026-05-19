import { describe, it, expect } from "vitest";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HYPERINDEX_DIR = path.resolve(__dirname, "..", "hyperindex");

describe("HyperIndex ingestion layer", () => {
  it("hyperindex/ directory exists with expected files", () => {
    expect(existsSync(path.join(HYPERINDEX_DIR, "config.yaml"))).toBe(true);
    expect(existsSync(path.join(HYPERINDEX_DIR, "schema.graphql"))).toBe(true);
    expect(existsSync(path.join(HYPERINDEX_DIR, "package.json"))).toBe(true);
    expect(existsSync(path.join(HYPERINDEX_DIR, "tsconfig.json"))).toBe(true);
  });

  it("ABI JSON files exist for all protocols", () => {
    const abiDir = path.join(HYPERINDEX_DIR, "abis");
    expect(existsSync(path.join(abiDir, "uniswap_v2_factory.json"))).toBe(true);
    expect(existsSync(path.join(abiDir, "uniswap_v2_pool.json"))).toBe(true);
    expect(existsSync(path.join(abiDir, "uniswap_v3_factory.json"))).toBe(true);
    expect(existsSync(path.join(abiDir, "uniswap_v3_pool.json"))).toBe(true);
    expect(existsSync(path.join(abiDir, "curve_factory.json"))).toBe(true);
    expect(existsSync(path.join(abiDir, "erc20.json"))).toBe(true);
    expect(existsSync(path.join(abiDir, "uniswap_v4_pool_manager.json"))).toBe(true);
  });

  it("handler files exist for all protocols", () => {
    const handlerDir = path.join(HYPERINDEX_DIR, "src", "handlers_ts");
    expect(existsSync(path.join(handlerDir, "v2_factory.ts"))).toBe(true);
    expect(existsSync(path.join(handlerDir, "v2_pool.ts"))).toBe(true);
    expect(existsSync(path.join(handlerDir, "v3_factory.ts"))).toBe(true);
    expect(existsSync(path.join(handlerDir, "v3_pool.ts"))).toBe(true);
    expect(existsSync(path.join(handlerDir, "curve_factory.ts"))).toBe(true);
    expect(existsSync(path.join(handlerDir, "v4.ts"))).toBe(true);
  });

  it("createEffect files exist", () => {
    const effectDir = path.join(HYPERINDEX_DIR, "src", "effects");
    expect(existsSync(path.join(effectDir, "token_decimals.ts"))).toBe(true);
    expect(existsSync(path.join(effectDir, "curve_metadata.ts"))).toBe(true);
    expect(existsSync(path.join(effectDir, "balancer_metadata.ts"))).toBe(true);
  });

  it("HyperIndex DB reader functions exist in infra", () => {
    const readerPath = path.resolve(__dirname, "..", "src", "infra", "db", "hyperindex_reader.ts");
    expect(existsSync(readerPath)).toBe(true);
  });

  it("HyperIndex process manager exists", () => {
    const procPath = path.resolve(__dirname, "..", "src", "infra", "hypersync", "hyperindex_process.ts");
    expect(existsSync(procPath)).toBe(true);
  });
});
