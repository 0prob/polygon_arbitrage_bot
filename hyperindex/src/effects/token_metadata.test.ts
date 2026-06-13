import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchTokenMetaHandler, resetTokenMetadataCachesForTest } from './token_metadata';
import { publicClient } from './rpc_client';

// Mock the dependencies
vi.mock('./rpc_client', () => ({
  publicClient: {
    readContract: vi.fn(),
  },
}));

// Mock bun:sqlite — must be a constructable class (vitest + dynamic import)
vi.mock("bun:sqlite", () => {
  class MockDatabase {
    prepare(_sql: string) {
      return {
        all: () => [{ address: "0xabcdef1234567890abcdef1234567890abcdef12", decimals: 18 }],
      };
    }
  }
  return { Database: MockDatabase };
});

// Mock fs/promises
const readFileMock = vi.fn().mockRejectedValue(new Error('File not found'));
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

describe('fetchTokenMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTokenMetadataCachesForTest();
    readFileMock.mockRejectedValue(new Error('File not found'));
  });

  it('should return from SQLite registry cache without hitting RPC', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0xabcdef1234567890abcdef1234567890abcdef12' };

    (publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(18);

    const result = await fetchTokenMetaHandler({ input, context });
    expect(result).toEqual({ address: '0xabcdef1234567890abcdef1234567890abcdef12', decimals: 18 });
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it('should return from in-memory cache on second call', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0xabcdef1234567890abcdef1234567890abcdef12' };

    (publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(18);

    await fetchTokenMetaHandler({ input, context });
    await fetchTokenMetaHandler({ input, context });

    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it('should load auto-extra-tokens.json into cache without RPC', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (String(filePath).includes('auto-extra-tokens.json')) {
        return JSON.stringify([{ address: '0x1234567890123456789012345678901234567890', decimals: 6 }]);
      }
      throw new Error('File not found');
    });

    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0x1234567890123456789012345678901234567890' };

    const result = await fetchTokenMetaHandler({ input, context });
    expect(result.decimals).toBe(6);
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });
});
