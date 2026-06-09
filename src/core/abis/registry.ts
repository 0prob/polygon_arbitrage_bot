import { Abi, AbiFunction, AbiError, Hex, toFunctionSelector, toErrorSelector } from 'viem';

export type RegistryEntry<T extends AbiFunction | AbiError> = {
  abiItem: T;
  tag?: string;
};

export class AbiRegistry {
  private functions = new Map<Hex, RegistryEntry<AbiFunction>[]>();
  private errors = new Map<Hex, RegistryEntry<AbiError>[]>();

  constructor() {}

  registerAbi(abi: Abi, tag?: string) {
    for (const item of abi) {
      if (item.type === 'function' || item.type === 'error') {
        this.registerItem(item, tag);
      }
    }
  }

  registerItem(item: AbiFunction | AbiError, tag?: string) {
    if (item.type === 'function') {
      const selector = toFunctionSelector(item);
      const entries = this.functions.get(selector) || [];
      entries.push({ abiItem: item, tag });
      this.functions.set(selector, entries);
    } else if (item.type === 'error') {
      const selector = toErrorSelector(item);
      const entries = this.errors.get(selector) || [];
      entries.push({ abiItem: item, tag });
      this.errors.set(selector, entries);
    }
  }
}
