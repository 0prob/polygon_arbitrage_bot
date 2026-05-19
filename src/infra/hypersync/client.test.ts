import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { HyperSyncClientConfig } from "./types.ts";

// Mocks
const mockGetHeight = vi.fn().mockResolvedValue(12345);
const mockGet = vi.fn().mockResolvedValue({ nextBlock: 1000, data: { logs: [] } });
const mockRecv = vi.fn().mockResolvedValue(null);
const mockStream = vi.fn().mockResolvedValue({ recv: mockRecv });

let mockClientInstanceCount = 0;

vi.mock("@envio-dev/hypersync-client", () => {
  class MockHypersyncClient {
    config: any;
    constructor(config: any) {
      this.config = config;
      mockClientInstanceCount++;
    }
    getHeight = mockGetHeight;
    get = mockGet;
    stream = mockStream;
    getChainId = vi.fn().mockResolvedValue(137);
    streamHeight = vi.fn().mockResolvedValue({ height: 12345 });
    streamEvents = vi.fn();
    collect = vi.fn();
    collectEvents = vi.fn();
    rateLimitInfo = vi.fn();
    waitForRateLimit = vi.fn();
  }
  return { HypersyncClient: MockHypersyncClient };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockClientInstanceCount = 0;
  vi.resetModules();
});

describe("createHypersyncClient", () => {
  it("creates client from config", async () => {
    const { createHypersyncClient } = await import("./client.ts");
    const client = await createHypersyncClient({
      url: "https://polygon.hypersync.xyz",
      apiToken: "",
    });
    expect(client).toBeDefined();
    expect(typeof client.getHeight).toBe("function");
    expect(typeof client.get).toBe("function");
    expect(typeof client.stream).toBe("function");
  });

  it("client returns height from getHeight", async () => {
    const { createHypersyncClient } = await import("./client.ts");
    const client = await createHypersyncClient({
      url: "https://polygon.hypersync.xyz",
      apiToken: "",
    });
    const height = await client.getHeight();
    expect(height).toBe(12345);
  });
});

describe("lazy singleton proxy", () => {
  it("exports a client proxy that lazily creates client on access", async () => {
    const mod = await import("./client.ts");
    expect(mod.client).toBeDefined();
    const height = await mod.client.getHeight();
    expect(height).toBe(12345);
    expect(mockClientInstanceCount).toBe(1);
  });

  it("reuses same client instance across multiple accesses", async () => {
    const mod = await import("./client.ts");
    await mod.client.getHeight();
    await mod.client.getHeight();
    expect(mockClientInstanceCount).toBe(1);
  });

  it("does not create multiple clients when called concurrently", async () => {
    const mod = await import("./client.ts");

    await Promise.all([
      mod.client.getHeight(),
      mod.client.getHeight(),
      mod.client.getHeight(),
      mod.client.getHeight(),
      mod.client.getHeight(),
    ]);

    expect(mockClientInstanceCount).toBe(1);
  });
});

describe("normalizeClientConfig", () => {
  let normalizeClientConfig: (config: HyperSyncClientConfig) => Record<string, unknown>;

  beforeAll(async () => {
    const mod = await import("./client.ts");
    normalizeClientConfig = mod.normalizeClientConfig;
  });

  it("should throw if url is missing", () => {
    expect(() => normalizeClientConfig({} as any)).toThrow("url must be a non-empty string");
  });

  it("should create a valid config object", () => {
    const config = {
      url: "https://example.com",
      apiToken: "test-token",
      httpReqTimeoutMillis: 1000,
      maxNumRetries: 5,
      retryBackoffMs: 100,
      retryBaseMs: 200,
      retryCeilingMs: 2000,
      proactiveRateLimitSleep: true,
    };
    const normalized = normalizeClientConfig(config);
    expect(normalized).toEqual(config);
  });

  it("should ignore invalid optional parameters", () => {
    const config = {
      url: "https://example.com",
      httpReqTimeoutMillis: "invalid",
      maxNumRetries: -5,
      retryBackoffMs: 0,
    };
    const normalized = normalizeClientConfig(config as any);
    expect(normalized).toEqual({
      url: "https://example.com",
      apiToken: "",
    });
  });
});
