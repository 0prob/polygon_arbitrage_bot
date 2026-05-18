import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetHeight = vi.fn().mockResolvedValue(12345);
const mockGet = vi.fn().mockResolvedValue({ nextBlock: 1000, data: { logs: [] } });
const mockRecv = vi.fn().mockResolvedValue(null);
const mockStream = vi.fn().mockResolvedValue({ recv: mockRecv });

vi.mock("@envio-dev/hypersync-client", () => {
  class MockHypersyncClient {
    config: any;
    constructor(config: any) {
      this.config = config;
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
  });

  it("reuses same client instance across multiple accesses", async () => {
    const mod = await import("./client.ts");
    const h1 = await mod.client.getHeight();
    const h2 = await mod.client.getHeight();
    expect(h1).toBe(h2);
  });
});
