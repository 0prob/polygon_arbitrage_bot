import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIndexerMetaFromHasura, fetchIndexerProgressFromHasura } from "./hyperindex_graphql.ts";

describe("fetchIndexerMetaFromHasura", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads official _meta progressBlock", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          _meta: [{ chainId: 137, progressBlock: 50_000_000, sourceBlock: 50_000_100, isReady: false }],
        },
      }),
    } as Response);

    const result = await fetchIndexerMetaFromHasura("http://localhost/v1/graphql", "secret", 137);
    expect(result?.lastProcessedBlock).toBe(50_000_000);
    expect(result?.sourceBlock).toBe(50_000_100);
  });
});

describe("fetchIndexerProgressFromHasura", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to IndexerProgress when _meta is empty", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { _meta: [] } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            IndexerProgress: [{ chainId: 137, lastProcessedBlock: 123, updatedAtBlock: 123 }],
          },
        }),
      } as Response);

    const result = await fetchIndexerProgressFromHasura("http://localhost/v1/graphql", "secret", undefined, 137);
    expect(result?.lastProcessedBlock).toBe(123);
  });
});
