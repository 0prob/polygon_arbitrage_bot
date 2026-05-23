import { describe, it, expect } from 'vitest';
import { createInitialState, applyEvent } from '../../src/tui/state';

describe('Profit/s calculation', () => {
  it('calculates profit per second correctly', () => {
    const state = createInitialState();
    const now = Date.now();
    state._startTime = now - 10000; // Started 10 seconds ago
    
    // Add 1000 wei profit
    applyEvent(state, {
      type: "opportunity_found",
      profitWei: 1000n,
      routeKey: "0x123",
    } as any);

    const profitPerSecond = Number(state.metrics.totalProfitWei) / ((Date.now() - state._startTime) / 1000);
    expect(profitPerSecond).toBeGreaterThan(0);
    expect(profitPerSecond).toBeCloseTo(100);
  });
});
