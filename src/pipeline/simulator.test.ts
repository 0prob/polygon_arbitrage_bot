import { describe, it, expect } from 'vitest';
import { simulateHop } from './simulator.ts';
import type { PoolState } from '../core/types/pool.ts';
import type { SimulationEdge } from './types.ts';
import type { CurvePoolState } from '../core/types/pool.ts';

describe('Simulator Verification', () => {
    const mockCurveState: CurvePoolState = {
        balances: [1000n * 10n**18n, 1000n * 10n**18n],
        rates: [10n**18n, 10n**18n],
        A: 100n,
        fee: 10n**7n, // 0.1%
        nCoins: 2,
    };

    it('simulates Curve swap correctly', () => {
        const edge: SimulationEdge = {
            poolAddress: '0xcurve',
            protocol: 'CURVE',
            normalizedProtocol: 'CURVE',
            zeroForOne: true,
            tokenInIdx: 0,
            tokenOutIdx: 1,
            stateRef: mockCurveState as unknown as PoolState,
        } as SimulationEdge;
        
        const result = simulateHop(edge, 1n * 10n**18n, new Map());
        expect(result.amountOut).toBeGreaterThan(0n);
    });
});
