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

    const mockBalancerState: PoolState = {
        balances: [1000n * 10n**18n, 1000n * 10n**18n],
        weights: [500000000000000000n, 500000000000000000n],
    } as unknown as PoolState;

    it('simulates Balancer swap correctly', () => {
        const edge: SimulationEdge = {
            poolAddress: '0xbalancer',
            protocol: 'BALANCER',
            normalizedProtocol: 'BALANCER',
            zeroForOne: true,
            tokenInIdx: 0,
            tokenOutIdx: 1,
            stateRef: mockBalancerState,
        } as SimulationEdge;
        
        const result = simulateHop(edge, 1n * 10n**18n, new Map());
        expect(result.amountOut).toBeGreaterThan(0n);
    });

    it('applies fee for Curve swap', () => {
        const edge: SimulationEdge = {
            poolAddress: '0xcurve',
            protocol: 'CURVE',
            normalizedProtocol: 'CURVE',
            zeroForOne: true,
            tokenInIdx: 0,
            tokenOutIdx: 1,
            stateRef: mockCurveState as unknown as PoolState,
        } as SimulationEdge;
        
        const resultWithFee = simulateHop(edge, 1n * 10n**18n, new Map());
        
        const stateNoFee = { ...mockCurveState, fee: 0n };
        const edgeNoFee = { ...edge, stateRef: stateNoFee as unknown as PoolState };
        const resultNoFee = simulateHop(edgeNoFee, 1n * 10n**18n, new Map());
        
        expect(resultNoFee.amountOut).toBeGreaterThan(resultWithFee.amountOut);
    });

    it('handles zero liquidity for Curve', () => {
        const zeroState: CurvePoolState = {
            balances: [0n, 0n],
            rates: [10n**18n, 10n**18n],
            A: 100n,
            fee: 10n**7n,
            nCoins: 2,
        };
        const edge: SimulationEdge = {
            poolAddress: '0xcurve-zero',
            protocol: 'CURVE',
            normalizedProtocol: 'CURVE',
            zeroForOne: true,
            tokenInIdx: 0,
            tokenOutIdx: 1,
            stateRef: zeroState as unknown as PoolState,
        } as SimulationEdge;
        
        const result = simulateHop(edge, 1n * 10n**18n, new Map());
        expect(result.amountOut).toBe(0n);
    });

    it('applies fee for Balancer swap', () => {
        const stateWithFee = { ...mockBalancerState, swapFee: 10n**16n }; // 1%
        const edgeWithFee: SimulationEdge = {
            poolAddress: '0xbalancer',
            protocol: 'BALANCER',
            normalizedProtocol: 'BALANCER',
            zeroForOne: true,
            tokenInIdx: 0,
            tokenOutIdx: 1,
            stateRef: stateWithFee as unknown as PoolState,
        } as SimulationEdge;
        
        const resultWithFee = simulateHop(edgeWithFee, 1n * 10n**18n, new Map());
        
        const stateNoFee = { ...mockBalancerState, swapFee: 0n };
        const edgeNoFee: SimulationEdge = {
            ...edgeWithFee,
            stateRef: stateNoFee as unknown as PoolState,
        };
        const resultNoFee = simulateHop(edgeNoFee, 1n * 10n**18n, new Map());
        
        expect(resultNoFee.amountOut).toBeGreaterThan(resultWithFee.amountOut);
    });

    it('handles zero liquidity for Balancer', () => {
        const zeroState: BalancerPoolState = {
            balances: [0n, 0n],
            weights: [500000000000000000n, 500000000000000000n],
            fee: 10n**15n, // 0.1%
            poolType: 'weighted',
        };
        const edge: SimulationEdge = {
            poolAddress: '0xbalancer-zero',
            protocol: 'BALANCER',
            normalizedProtocol: 'BALANCER',
            zeroForOne: true,
            tokenInIdx: 0,
            tokenOutIdx: 1,
            stateRef: zeroState as unknown as PoolState,
        } as SimulationEdge;
        
        const result = simulateHop(edge, 1n * 10n**18n, new Map());
        expect(result.amountOut).toBe(0n);
    });
});
