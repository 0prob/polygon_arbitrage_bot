import { Abi, AbiFunction, AbiError, Hex } from 'viem';

export type RegistryEntry<T extends AbiFunction | AbiError> = {
  abiItem: T;
  tag?: string;
};

export class AbiRegistry {
  private functions = new Map<Hex, RegistryEntry<AbiFunction>[]>();
  private errors = new Map<Hex, RegistryEntry<AbiError>[]>();

  constructor() {}
}
