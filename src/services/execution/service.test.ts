import { describe, it, expect, vi } from 'vitest';
import { ExecutionService } from './service.ts';
import type { Logger } from '../../infra/observability/logger.ts';
import type { GasOracle } from './gas.ts';
import type { NonceManager } from './nonce.ts';

describe('ExecutionService', () => {
  const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const mockGasOracle = { start: vi.fn(), stop: vi.fn(), getSnapshot: vi.fn() } as unknown as GasOracle;
  const mockNonceManager = { initialize: vi.fn(), getNextNonce: vi.fn(), confirmNonce: vi.fn(), markInFlight: vi.fn(), markStale: vi.fn() } as unknown as NonceManager;
  const mockSubmitTx = vi.fn();

  it('quarantines route on gas data failure', async () => {
    const service = new ExecutionService(mockLogger, mockGasOracle, mockNonceManager, [mockSubmitTx]);
    
    vi.spyOn(mockGasOracle, 'getSnapshot').mockReturnValue(null);

    const candidate = {
      routeKey: 'test-route-gas',
      calldata: '0x',
      targetAddress: '0x123',
      value: 0n,
    };

    const result = await service.execute(candidate);

    expect(result.success).toBe(false);
    expect(result.error).toBe('no gas data');
    expect(service.isQuarantined('test-route-gas')).toBe(true);
  });

  it('quarantines route on execution failure', async () => {
    const service = new ExecutionService(mockLogger, mockGasOracle, mockNonceManager, [mockSubmitTx]);
    
    vi.spyOn(mockGasOracle, 'getSnapshot').mockReturnValue({ 
      baseFee: 100n, 
      priorityFee: 10n, 
      maxFee: 110n, 
      gasPrice: 110n, 
      timestamp: Date.now() 
    });
    vi.spyOn(mockNonceManager, "getNextNonce").mockReturnValue(1);
    mockSubmitTx.mockRejectedValue(new Error('tx failed'));

    const candidate = {
      routeKey: 'test-route-execution',
      calldata: '0x',
      targetAddress: '0x123',
      value: 0n,
    };

    const result = await service.execute(candidate);

    expect(result.success).toBe(false);
    expect(result.error).toBe('tx failed');
    expect(service.isQuarantined('test-route-execution')).toBe(true);
  });
});
