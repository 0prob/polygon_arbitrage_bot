import { describe, it, expect, beforeEach } from 'vitest';
import { AbiRegistry } from './registry';
import { parseAbi, Hex, encodeFunctionData, encodeErrorResult } from 'viem';

describe('AbiRegistry', () => {
  let registry: AbiRegistry;

  beforeEach(() => {
    registry = new AbiRegistry();
  });

  it('should register and lookup functions', () => {
    const abi = parseAbi(['function transfer(address to, uint256 amount)']);
    registry.registerAbi(abi, 'ERC20');
    const data = encodeFunctionData({
      abi,
      functionName: 'transfer',
      args: ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 100n],
    });
    const decoded = registry.decodeCall(data);
    expect(decoded?.functionName).toBe('transfer');
    expect(decoded?.tag).toBe('ERC20');
  });

  it('should handle overloaded functions', () => {
    const abi1 = parseAbi(['function transfer(address to, uint256 amount)']);
    const abi2 = parseAbi(['function transfer(address to, uint256 amount, bytes data)']);
    registry.registerAbi(abi1, 'v1');
    registry.registerAbi(abi2, 'v2');

    const data1 = encodeFunctionData({
      abi: abi1,
      functionName: 'transfer',
      args: ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 100n],
    });
    const data2 = encodeFunctionData({
      abi: abi2,
      functionName: 'transfer',
      args: ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 100n, '0x1234'],
    });

    const decoded1 = registry.decodeCall(data1);
    const decoded2 = registry.decodeCall(data2);

    expect(decoded1?.tag).toBe('v1');
    expect(decoded2?.tag).toBe('v2');
  });

  it('should decode errors', () => {
    const abi = parseAbi(['error InsufficientBalance(uint256 available, uint256 required)']);
    registry.registerAbi(abi, 'Errors');
    const data = encodeErrorResult({
      abi,
      errorName: 'InsufficientBalance',
      args: [10n, 100n],
    });
    console.log('Encoded Error Data:', data);
    console.log('Encoded Error Selector:', data.slice(0, 10));
    const decoded = registry.decodeError(data);
    expect(decoded?.errorName).toBe('InsufficientBalance');
    expect(decoded?.args).toEqual([10n, 100n]);
    expect(decoded?.tag).toBe('Errors');
  });
});
