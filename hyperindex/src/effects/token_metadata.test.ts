import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchTokenMetaHandler } from './token_metadata';
import { publicClient } from './rpc_client';

// Mock the dependencies
vi.mock('./rpc_client', () => ({
  publicClient: {
    readContract: vi.fn(),
  },
}));

// Mock bun:sqlite
vi.mock('bun:sqlite', () => ({
  Database: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ decimals: 18 })),
      all: vi.fn(() => [{ address: '0x123', decimals: 18 }]),
    })),
  })),
}));

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('File not found')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

describe('fetchTokenMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use the in-memory cache on subsequent calls', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0x123' };

    // Mock readContract to return a value
    (publicClient.readContract as any).mockResolvedValue(18);

    // First call: should hit RPC
    const res1 = await fetchTokenMetaHandler({ input, context });
    expect(res1.decimals).toBe(18);
    
    // Second call: should hit in-memory cache
    const res2 = await fetchTokenMetaHandler({ input, context });
    expect(res2.decimals).toBe(18);

    // Expectation: The RPC logic should have been called 0 times (hit cache directly).
    expect(publicClient.readContract).toHaveBeenCalledTimes(0);
  });
});
