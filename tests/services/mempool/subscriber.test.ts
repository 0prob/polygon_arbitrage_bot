import { describe, it, expect, vi } from 'vitest';
import { PoolStateSubscriber } from '../../../src/services/mempool/subscriber';
import { type PublicClient, type Address } from 'viem';

describe('PoolStateSubscriber', () => {
  it('calls onPoolUpdate when a swap event is detected', async () => {
    const onPoolUpdate = vi.fn();
    const mockClient = {
      watchContractEvent: vi.fn((opts) => {
        // Trigger the callback immediately to simulate event detection
        opts.onLogs([{
          args: {
            sqrtPriceX96: 12345n,
            liquidity: 100n,
            tick: 10
          }
        }]);
      })
    } as unknown as PublicClient;

    const subscriber = new PoolStateSubscriber({
      client: mockClient,
      onPoolUpdate
    });

    const poolAddress = '0x1234567890123456789012345678901234567890' as Address;
    await subscriber.subscribe(poolAddress);

    expect(mockClient.watchContractEvent).toHaveBeenCalledWith(expect.objectContaining({
      address: poolAddress,
      eventName: 'Swap'
    }));
    expect(onPoolUpdate).toHaveBeenCalledWith(poolAddress, {
      sqrtPriceX96: 12345n,
      liquidity: 100n,
      tick: 10
    });
  });
});
