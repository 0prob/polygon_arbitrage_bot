import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInitialState, applyEvent } from '../../src/tui/state';

describe('Profit/s calculation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calculates profit per second correctly', () => {
    const state = createInitialState();
    const now = 1716465600000; // Fixed timestamp
    vi.setSystemTime(now);
    
    state._startTime = now - 10000; // Started 10 seconds ago
    
    // Add 1000 wei profit
    applyEvent(state, {
      type: "opportunity_found",
      profitWei: 1000n,
      routeKey: "0x123",
    } as any);

    const profitPerSecond = state.metrics.profitPerSecond;
    expect(profitPerSecond).toBeGreaterThan(0);
    expect(profitPerSecond).toBeCloseTo(100);
  });
});
