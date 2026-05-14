import { normalizeEvmAddress } from "../../utils/identity.ts";

export function normalizeTokenHydrationAddress(address: unknown) {
  return normalizeEvmAddress(address);
}

export function normalizeHydrationAddresses(tokenAddresses: unknown) {
  if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) return [];
  return [...new Set(tokenAddresses.map(normalizeTokenHydrationAddress).filter((address): address is string => address != null))];
}
