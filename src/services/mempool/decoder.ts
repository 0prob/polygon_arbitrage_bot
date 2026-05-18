import type { Address } from "../../core/types/common.ts";

// Known function selectors for swap methods
const SELECTORS: Record<string, string> = {
  "0x022c0d9f": "UNISWAP_V2",  // swap(uint256,uint256,address,bytes)
  "0x128acb08": "UNISWAP_V3",  // swap(address,bool,int256,uint160,bytes)
  "0x52bbbe29": "BALANCER_V2",  // swap((bytes32,uint8,address,address,uint256,bytes),...,uint256)
  "0x3df02124": "CURVE_STABLE", // exchange(int128,int128,uint256,uint256)
  "0x5b41b908": "CURVE_CRYPTO", // exchange(uint256,uint256,uint256,uint256)
  "0x5c0c4997": "DODO_V2",      // sellBase(address,uint256,uint256,bytes)
  "0x6b5a7b77": "DODO_V2",      // sellQuote(address,uint256,uint256,bytes)
  "0x9ba7e8a9": "WOOFI",        // swap(address,uint256,uint256,address,address)
  "0x3b358e1b": "KYBERSWAP_ELASTIC", // swap(address,address,uint256,bytes)
};

export interface DecodedSwap {
  protocol: string;
  poolAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}

/**
 * Decode a transaction's input data to identify a swap.
 * Returns null if the input doesn't match a known swap selector.
 */
export function decodeSwapCalldata(
  to: Address,
  input: string,
  knownPools: Set<string>,
): DecodedSwap | null {
  if (!input || input.length < 10) return null;
  const selector = input.slice(0, 10).toLowerCase();
  const protocol = SELECTORS[selector];
  if (!protocol) return null;

  // V2 swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)
  if (protocol === "UNISWAP_V2" && knownPools.has(to.toLowerCase())) {
    const amount0Out = BigInt("0x" + input.slice(10, 74));
    const amount1Out = BigInt("0x" + input.slice(74, 138));
    if (amount0Out > 0n) {
      return { protocol, poolAddress: to, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount0Out };
    }
    return { protocol, poolAddress: to, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount1Out };
  }

  return null;
}

/**
 * Extract all addresses from a transaction's input data.
 * Used for pool indexing — any address in the input might be a pool or token.
 */
export function extractEncodedAddresses(input: string): string[] {
  const addrs: string[] = [];
  if (!input || input.length < 42) return addrs;
  for (let i = 2; i < input.length - 40; i += 64) {
    const chunk = "0x" + input.slice(i + 24, i + 64);
    if (chunk.length === 42) addrs.push(chunk.toLowerCase());
  }
  return addrs;
}
