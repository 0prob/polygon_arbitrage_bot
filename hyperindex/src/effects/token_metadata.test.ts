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
      all: vi.fn(() => [{ address: '0xabcdef1234567890abcdef1234567890abcdef12', decimals: 18 }]),
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

  it('should return from SQLite registry cache without hitting RPC', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0xabcdef1234567890abcdef1234567890abcdef12' };

    (publicClient.readContract as any).mockResolvedValue(18);

    const result = await fetchTokenMetaHandler({ input, context });
    expect(result).toEqual({ address: '0xabcdef1234567890abcdef1234567890abcdef12', decimals: 18 });
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it('should return from in-memory cache on second call', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0xabcdef1234567890abcdef1234567890abcdef12' };

    (publicClient.readContract as any).mockResolvedValue(18);

    await fetchTokenMetaHandler({ input, context });
    await fetchTokenMetaHandler({ input, context });

    expect(publicClient.readContract).not.toHaveBeenCalled();
  });
});
