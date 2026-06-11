import { type AbiFunction, type Hex, toFunctionSelector, decodeFunctionData, decodeErrorResult, parseAbiItem } from 'viem';

export type RegistryEntry<T extends AbiFunction | AbiError> = {
  abiItem: T;
  tag?: string;
};

type AbiError = { type: 'error'; name: string; inputs: readonly { name: string; type: string; [key: string]: unknown }[] };

const COMMON_ERRORS = [
  'error Error(string)',
  'error Panic(uint256)',
].map(s => parseAbiItem(s) as AbiError);

export class AbiRegistry {
  private functions = new Map<Hex, RegistryEntry<AbiFunction>[]>();
  private errors = new Map<Hex, RegistryEntry<AbiError>[]>();

  constructor() {
    this.registerAbi(COMMON_ERRORS, 'Common');
  }

  registerAbi(abi: readonly any[], tag?: string) {
    for (const item of abi) {
      if (item.type === 'function' || item.type === 'error') {
        this.registerItem(item, tag);
      }
    }
  }

  registerItem(item: AbiFunction | AbiError, tag?: string) {
    const shim: any = { ...item };
    if (item.type === 'error') {
      shim.type = 'function';
      shim.outputs = [];
      shim.stateMutability = 'nonpayable';
    }
    const selector = toFunctionSelector(shim);
    
    if (item.type === 'function') {
      const entries = this.functions.get(selector) || [];
      entries.push({ abiItem: item, tag });
      this.functions.set(selector, entries);
    } else if (item.type === 'error') {
      const entries = this.errors.get(selector) || [];
      entries.push({ abiItem: item, tag });
      this.errors.set(selector, entries);
    }
  }

  decodeCall(data: Hex) {
    if (data.length < 10) return null;
    const selector = data.slice(0, 10).toLowerCase() as Hex;
    const entries = this.functions.get(selector);
    if (!entries) return null;

    for (const entry of entries) {
      try {
        const decoded = decodeFunctionData({
          abi: [entry.abiItem],
          data,
        });
        return { ...decoded, tag: entry.tag, abiItem: entry.abiItem };
      } catch (err) {
        console.warn("[abi-registry] decodeCall failed:", err);
        continue;
      }
    }
    return null;
  }

  decodeError(data: Hex) {
    if (data.length < 10) return null;
    const selector = data.slice(0, 10).toLowerCase() as Hex;
    const entries = this.errors.get(selector);
    if (!entries) return null;

    for (const entry of entries) {
      try {
        const decoded = decodeErrorResult({
          abi: [entry.abiItem],
          data,
        });
        return { ...decoded, tag: entry.tag, abiItem: entry.abiItem };
      } catch (err) {
        console.warn("[abi-registry] decodeError failed:", err);
        continue;
      }
    }
    return null;
  }
}
