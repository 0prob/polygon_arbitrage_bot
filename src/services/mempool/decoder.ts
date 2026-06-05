import type { Address } from "../../core/types/common.ts";

// Known function selectors for swap methods
export const SELECTORS: Record<string, string> = {
  "0x022c0d9f": "UNISWAP_V2", // swap(uint256,uint256,address,bytes)
  "0x128acb08": "UNISWAP_V3", // swap(address,bool,int256,uint160,bytes)
  "0x52bbbe29": "BALANCER_V2", // swap((bytes32,uint8,address,address,uint256,bytes),...,uint256)
  "0x3df02124": "CURVE_STABLE", // exchange(int128,int128,uint256,uint256)
  "0x5b41b908": "CURVE_CRYPTO", // exchange(uint256,uint256,uint256,uint256)
  "0x5c0c4997": "DODO_V2", // sellBase(address,uint256,uint256,bytes)
  "0x6b5a7b77": "DODO_V2", // sellQuote(address,uint256,uint256,bytes)
  "0x9ba7e8a9": "WOOFI", // swap(address,uint256,uint256,address,address)
  "0x3b358e1b": "KYBERSWAP_ELASTIC", // swap(address,address,uint256,bytes)
  "0x6c70970e": "UNISWAP_V4", // swap((address,address,uint24,int24,address),bool,int128,uint160,bytes)
  "0x3c2b4399": "POLYMARKET_CTF", // matchOrders
  "0x01b7037c": "OTHER",
  "0xa00597a0": "OTHER",
  "0x5c11d795": "UNISWAP_V2_ROUTER", // swapExactTokensForTokensSupportingFeeOnTransferTokens
  "0x3829cab1": "CLAIM_INTEREST",
  "0x6a761202": "GNOSIS_SAFE", // execTransaction
  "0x46a73fb1": "SILENCE",
  "0xa694fc3a": "STAKE",
  "0x5638f1f3": "REDEEM_SILENCE",
  "0xd9f0f7f5": "UNSTAKE_PRINCIPAL",
  "0x0a3c4405": "POLYMARKET_DEPOSIT"
};

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
 * Returns null if the input doesn't match a known swap selector.
 */
export function decodeSwapCalldata(to: Address, input: string, knownPools: Set<string>): DecodedSwap | null {
  if (!input || input.length < 10) return null;
  const selector = input.slice(0, 10).toLowerCase();
  const protocol = SELECTORS[selector];
  if (!protocol) {
    console.debug(`mempool: ignored tx (unknown selector: ${selector})`);
    return null;
  }

  const lcTo = to.toLowerCase();
  let targetPool: string = lcTo;
  let isKnown = knownPools.has(lcTo);
  if (!isKnown) {
    const extracted = extractEncodedAddresses(input);
    const hit = extracted.find((a) => knownPools.has(a));
    if (hit) {
      isKnown = true;
      targetPool = hit;
    }
  }
  if (!isKnown) {
    console.debug(`mempool: ignored tx (unknown pool: ${lcTo})`);
    return null;
  }

  const poolAddress = targetPool as Address;
  const isDirect = lcTo === targetPool; // protocol-specific fixed-offset parses only valid for direct-to-pool calls

  // V2 swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data) -- direct to pair
  if (protocol === "UNISWAP_V2") {
    if (isDirect) {
      const amount0Out = BigInt("0x" + input.slice(10, 74));
      const amount1Out = BigInt("0x" + input.slice(74, 138));
      if (amount0Out > 0n) {
        return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount0Out, zeroForOne: false };
      }
      return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: amount1Out, zeroForOne: true };
    }
    // indirect V2: fallthrough to generic
  }

  if (protocol === "UNISWAP_V3" && isDirect) {
    // swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data)
    let amountSpecified = 0n;
    if (input.length >= 10 + 192) {
      try {
        amountSpecified = BigInt("0x" + input.slice(10 + 128, 10 + 192));
      } catch {}
    }
    const size = amountSpecified < 0n ? -amountSpecified : amountSpecified;
    let zeroForOne: boolean | undefined;
    if (input.length >= 10 + 128) {
      try {
        const zfoWord = BigInt("0x" + input.slice(10 + 64, 10 + 128));
        zeroForOne = zfoWord !== 0n;
      } catch {}
    }
    return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn: size || 1n, zeroForOne };
  }

  // Generic for BALANCER_V2, CURVE_*, DODO_V2, WOOFI, KYBERSWAP_ELASTIC, and indirect V2/V3.
  // Improved heuristic: The amount is likely to be a large value, but we need to avoid picking up 
  // pool addresses or other large constants. Look for values in the calldata that 
  // are likely to be amounts based on typical swap sizes.
  let amountIn = 0n;
  const dataHex = input.slice(10);
  for (let j = 0; j + 64 <= dataHex.length; j += 2) {
    const w = dataHex.slice(j, j + 64);
    try {
      const v = BigInt("0x" + w);
      // Heuristic: swap amounts are typically smaller than addresses (160 bits) 
      // but large enough to be a meaningful swap (e.g., > 10^12 wei).
      if (v > 10n ** 12n && v < 1n << 160n) {
        // If we find multiple, we might want the most reasonable one.
        // For now, take the largest valid one as it's likely the amountSpecified.
        if (v > amountIn) {
          amountIn = v;
        }
      }
    } catch {}
  }
  if (amountIn === 0n) amountIn = 1n;
  return { protocol, poolAddress, tokenIn: "" as Address, tokenOut: "" as Address, amountIn };
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
