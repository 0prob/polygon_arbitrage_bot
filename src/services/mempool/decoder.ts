import { type Hex } from "viem";
import type { Address } from "../../core/types/common.ts";
import type { AbiRegistry } from "../../core/abis/registry.ts";

export interface DecodedSwap {
  protocol: string;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  zeroForOne?: boolean;
}

/**
 * Decode a transaction's input data to identify a swap.
 * Returns null if the input doesn't match a known swap selector or pool.
 */
export function decodeSwapCalldata(
  to: Address,
  input: string,
  knownPools: Set<string>,
  registry: AbiRegistry,
): DecodedSwap | null {
  if (!input || input.length < 10) return null;

  const selector = input.slice(0, 10).toLowerCase();
  if (!registry.hasSelector(selector)) return null;

  const decoded = registry.decodeCall(input as Hex);
  if (!decoded) return null;

  const { functionName, args, tag: protocolFromTag } = decoded;
  const protocol = protocolFromTag || "OTHER";

  const lcTo = to.toLowerCase();
  let targetPool: string = lcTo;
  let isKnown = knownPools.has(lcTo);

  // If not a direct call to a known pool, search the calldata for known pool addresses.
  if (!isKnown) {
    const extracted = extractEncodedAddresses(input, knownPools);
    const hit = extracted.find((a) => knownPools.has(a));
    if (hit) {
      isKnown = true;
      targetPool = hit;
    }
  }

  if (!isKnown) return null;

  const poolAddress = targetPool as Address;

  try {
    const argList = args as any[];

    // Protocol-specific mapping from decoded args to DecodedSwap
    if (protocol === "uniswap_v2_pool" && functionName === "swap") {
      const amount0Out = argList[0] as bigint;
      const amount1Out = argList[1] as bigint;
      if (amount0Out > 0n) {
        return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount0Out, zeroForOne: false };
      }
      return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount1Out, zeroForOne: true };
    }

    if (protocol === "uniswap_v3_pool" && functionName === "swap") {
      const zeroForOne = argList[1] as boolean;
      const amountSpecified = argList[2] as bigint;
      const size = amountSpecified < 0n ? -amountSpecified : amountSpecified;
      return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: size || 1n, zeroForOne };
    }

    // Generic fallback: try to find an argument that looks like an amount
    if (argList) {
      let bestAmount = 0n;
      for (const v of argList) {
        if (typeof v === "bigint") {
          // Heuristic: swap amounts are typically smaller than addresses (160 bits)
          // but large enough to be a meaningful swap (e.g., > 10^12 wei).
          if (v > 10n ** 12n && v < 1n << 160n) {
            if (v > bestAmount) bestAmount = v;
          }
        }
      }
      if (bestAmount > 0n) {
        return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: bestAmount };
      }
    }
  } catch {
    // Fallback to heuristic if decoding fails
  }

  // Final heuristic fallback (original logic)
  let amountIn = 0n;
  const dataHex = input.slice(10);
  for (let j = 0; j + 64 <= dataHex.length; j += 64) {
    const w = dataHex.slice(j, j + 64);
    try {
      const v = BigInt("0x" + w);
      if (v > 10n ** 12n && v < 1n << 160n) {
        if (v > amountIn) amountIn = v;
      }
    } catch (err) {
      console.warn("[mempool-decoder] Failed to parse hex word:", err);
    }
  }
  if (amountIn === 0n) amountIn = 1n;
  return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn };
}

/**
 * Extract pool addresses from calldata.
 * Word-aligned scan first (O(slots)); substring scan only for packed paths (e.g. V3).
 */
export function extractEncodedAddresses(input: string, knownPools?: Set<string>): string[] {
  if (!input || input.length < 42) return [];

  const addrs: string[] = [];

  if (knownPools && knownPools.size > 0) {
    for (let i = 10; i + 64 <= input.length; i += 64) {
      const addr = ("0x" + input.slice(i + 24, i + 64)).toLowerCase();
      if (knownPools.has(addr)) addrs.push(addr);
    }
    if (addrs.length > 0) return addrs;

    const lcInput = input.toLowerCase();
    for (const pool of knownPools) {
      const normalized = pool.startsWith("0x") ? pool.toLowerCase() : `0x${pool}`;
      const addrHex = normalized.slice(2);
      if (lcInput.includes(addrHex)) addrs.push(normalized);
    }
    return addrs;
  }

  for (let i = 10; i + 64 <= input.length; i += 64) {
    addrs.push(("0x" + input.slice(i + 24, i + 64)).toLowerCase());
  }
  return addrs;
}
