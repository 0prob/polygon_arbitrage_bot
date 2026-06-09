import { describe, it, expect, beforeEach } from 'vitest';
import { AbiRegistry } from './registry';
import { parseAbi } from 'viem';

describe('AbiRegistry', () => {
  let registry: AbiRegistry;

  beforeEach(() => {
    registry = new AbiRegistry();
  });

  it('should register and lookup functions', () => {
    const abi = parseAbi(['function transfer(address to, uint256 amount)']);
    registry.registerAbi(abi, 'ERC20');
  });
});
