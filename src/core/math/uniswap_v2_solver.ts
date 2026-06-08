import { toBigInt } from "../utils/bigint.ts";
import { resolveV2Fee } from "./uniswap_v2.ts";
import type { SimulationEdge } from "../../pipeline/types.ts";

/**
 * Computes the integer square root of a BigInt value using Newton's method.
 */
export function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("sqrt of negative number");
  if (value < 2n) return value;
  
  // Estimate bit length using binary checks to avoid expensive string conversions
  let bitLength = 0;
  let temp = value;
  if (temp >= 1n << 128n) { temp >>= 128n; bitLength += 128; }
  if (temp >= 1n << 64n) { temp >>= 64n; bitLength += 64; }
  if (temp >= 1n << 32n) { temp >>= 32n; bitLength += 32; }
  if (temp >= 1n << 16n) { temp >>= 16n; bitLength += 16; }
  if (temp >= 1n << 8n) { temp >>= 8n; bitLength += 8; }
  if (temp >= 1n << 4n) { temp >>= 4n; bitLength += 4; }
  if (temp >= 1n << 2n) { temp >>= 2n; bitLength += 2; }
  if (temp >= 1n << 1n) { temp >>= 1n; bitLength += 1; }
  if (temp > 0n) { bitLength += 1; }

  let x = 1n << BigInt(Math.floor(bitLength / 2) + 1);
  let y = (x + value / x) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * Closed-form optimal input solver for a cycle of Uniswap V2 pools.
 *
 * Composition of swaps: x_i = (a_i * x_{i-1}) / (b_i + x_{i-1})
 * Solves for optimal input size x* that maximizes: Profit(x) = f(x) - x
 *
 * Optimal x* = (sqrt(A * B) - B) / C
 */
export function solveV2Optimal(edges: SimulationEdge[]): bigint {
  if (edges.length === 0) return 0n;

  let A = 1n;
  let B = 1n;
  let C = 1n;

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const pool = edge.stateRef;
    if (!pool) return 0n;

    let r0 = toBigInt(pool.reserve0);
    let r1 = toBigInt(pool.reserve1);
    if (r0 <= 0n || r1 <= 0n) return 0n;

    // Apply the same 10 bps safety margin as simulateV2Swap
    r0 = (r0 * 9990n) / 10000n;
    r1 = (r1 * 9990n) / 10000n;

    const rIn = edge.zeroForOne ? r0 : r1;
    const rOut = edge.zeroForOne ? r1 : r0;

    const feeBps = edge.fee != null ? BigInt(edge.fee) : undefined;
    const { numerator: defaultNum, denominator } = resolveV2Fee(pool, undefined, 10000n);
    let numerator = defaultNum;
    if (feeBps !== undefined) {
      numerator = feeBps < 500n ? denominator - (feeBps * denominator) / 10000n : feeBps;
    }

    if (numerator <= 0n || denominator <= 0n || numerator >= denominator) return 0n;

    // a_i = reserveOut
    // b_i = reserveIn * feeDenominator / feeNumerator
    const a = rOut;
    const b = (rIn * denominator) / numerator;

    if (i === 0) {
      A = a;
      B = b;
      C = 1n;
    } else {
      const nextA = a * A;
      const nextB = b * B;
      const nextC = b * C + A;
      A = nextA;
      B = nextB;
      C = nextC;
    }
  }

  const AB = A * B;
  const sqrtAB = bigintSqrt(AB);
  if (sqrtAB <= B) {
    return 0n; // unprofitable
  }

  return (sqrtAB - B) / C;
}
