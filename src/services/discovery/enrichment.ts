import type { Address } from "../../core/types/common.ts";

export interface TokenMetaRemote {
  symbol: string;
  name: string;
  decimals: number;
}

export type TokenMetaFetcher = (tokenAddresses: Address[]) => Promise<Map<Address, TokenMetaRemote>>;

export function isSkipToken(address: Address): boolean {
  const lower = address.toLowerCase();
  const prefixes = ["0x02", "0x03", "0x04", "0x05", "0x06", "0x07", "0x08", "0x09", "0x0a", "0x0b", "0x0c", "0x0d", "0x0e", "0x0f"];
  return prefixes.some((p) => lower.startsWith(p));
}
