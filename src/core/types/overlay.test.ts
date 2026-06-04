import { describe, it, expect, beforeEach } from 'vitest';
import type { Address } from './common.ts';
import type { PoolState } from './pool.ts';
import { InMemoryPendingStateOverlay } from './overlay.ts';

describe('InMemoryPendingStateOverlay', () => {
  let overlay: InMemoryPendingStateOverlay;

  beforeEach(() => {
    overlay = new InMemoryPendingStateOverlay();
  });

  it('should update and get state', () => {
    const address = '0x1234567890123456789012345678901234567890' as Address;
    const state: PoolState = { reserve0: 100n, reserve1: 200n };
    overlay.update(address, state);
    expect(overlay.get(address)).toEqual(state);
  });

  it('should return undefined for expired state', async () => {
    const address = '0x1234567890123456789012345678901234567890' as Address;
    const state: PoolState = { reserve0: 100n, reserve1: 200n };
    overlay.update(address, state);

    // Manually wait for TTL (200ms)
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(overlay.get(address)).toBeUndefined();
  });

  it('should clear all states', () => {
    const address1 = '0x1234567890123456789012345678901234567890' as Address;
    const address2 = '0x0000000000000000000000000000000000000000' as Address;
    const state: PoolState = { reserve0: 100n, reserve1: 200n };
    overlay.update(address1, state);
    overlay.update(address2, state);
    overlay.clear();
    expect(overlay.get(address1)).toBeUndefined();
    expect(overlay.get(address2)).toBeUndefined();
  });
});
