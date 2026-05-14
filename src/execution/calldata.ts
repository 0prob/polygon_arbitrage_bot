/**
 * src/execution/calldata.js — Multihop calldata encoder
 *
 * Converts a simulated arbitrage route (from src/routing/simulator.js)
 * into a Call[] array suitable for ArbExecutor.executeArb().
 *
 * Encoding strategy per protocol:
 *
 *   V2 (QuickSwap, SushiSwap) — Direct pair.swap pattern:
 *     Call 1: ERC20(tokenIn).transfer(pair, amountIn)
 *     Call 2: pair.swap(amount0Out, amount1Out, recipient, "0x")
 *
 *   V3 (Uniswap V3) — Direct pool.swap pattern:
 *     Call 1: pool.swap(recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, callbackData)
 *     (ArbExecutor implements IUniswapV3SwapCallback to pay the pool)
 *
 * All amounts are BigInt. Addresses are checksummed via viem's getAddress().
 */

import { asRecord } from "../utils/errors.ts";
import { encodeFunctionData, getAddress, keccak256, encodeAbiParameters } from "viem";
import {
  ERC20_TRANSFER_ABI,
  KYBER_ELASTIC_POOL_SWAP_ABI,
  DODO_SELL_BASE_ABI,
  DODO_SELL_QUOTE_ABI,
  WOOFI_ROUTER_SWAP_ABI,
  V2_PAIR_SWAP_ABI,
  V3_POOL_SWAP_ABI,
  CURVE_EXCHANGE_INT128_ABI,
  CURVE_EXCHANGE_UINT256_ABI,
  CURVE_EXCHANGE_INT128_RECEIVER_ABI,
  BALANCER_VAULT_SWAP_ABI,
  EXECUTOR_ABI,
  EXECUTOR_APPROVE_IF_NEEDED_ABI,
} from "./abi_fragments.ts";
import {
  BALANCER_VAULT,
  DIRECT_SWAP_PROTOCOLS,
  CURVE_STABLE_PROTOCOLS,
  CURVE_CRYPTO_PROTOCOLS,
  BALANCER_PROTOCOLS,
  DODO_PROTOCOLS,
  WOOFI_PROTOCOLS,
  WOOFI_ROUTER_V2,
  V3_SWAP_PROTOCOLS,
} from "./addresses.ts";
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../math/tick_math.ts";
import { simulateV3Swap } from "../math/uniswap_v3.ts";
import { normalizeProtocolKey } from "../protocols/classification.ts";

const CALL_STRUCT_ARRAY_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

export type ExecutorCall = {
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
};

export type CalldataHop = {
  protocol?: unknown;
  poolAddress?: unknown;
  tokenIn?: unknown;
  tokenOut?: unknown;
  zeroForOne?: unknown;
  amountIn?: unknown;
  amountOut?: unknown;
  fee?: unknown;
  swapFeeBps?: unknown;
  kyberSwapFeeBps?: unknown;
  router?: unknown;
  metadata?: Record<string, unknown>;
  tokenInIdx?: unknown;
  tokenOutIdx?: unknown;
  isCrypto?: unknown;
  poolId?: unknown;
  stateRef?: Record<string, unknown>;
};

export type CalldataRoute = {
  path: {
    edges: CalldataHop[];
  };
  result: {
    hopAmounts: unknown[];
  };
};

export type RouteCalldataOptions = {
  slippageBps?: number;
  deadline?: bigint;
};

export type FlashParamsInput = {
  profitToken: string;
  minProfit: bigint;
  deadline: bigint;
  calls: unknown;
};

export type ExecuteArbInput = FlashParamsInput & {
  executorAddress: string;
  flashToken: string;
  flashAmount: bigint;
};

type BigNumberish = bigint | number | string | boolean;

function asAddress(value: unknown) {
  return getAddress(String(value));
}

function normalizeExecutorCall(call: unknown, index: number): ExecutorCall {
  if (!call || typeof call !== "object") {
    throw new Error(`executor call ${index} must be an object`);
  }

  const record = call as { target?: unknown; value?: unknown; data?: unknown };
  const target = asAddress(record.target);
  const value = normalizeUint(record.value ?? 0n, `executor call ${index} value`);

  const data = typeof record.data === "string" ? record.data : "";
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error(`executor call ${index} data must be a 0x-prefixed even-length hex string`);
  }

  return {
    target,
    value,
    data: data.toLowerCase() as `0x${string}`,
  };
}

function normalizeExecutorCalls(calls: unknown): ExecutorCall[] {
  if (!Array.isArray(calls)) {
    throw new Error("executor calls must be an array");
  }
  return calls.map((call, index) => normalizeExecutorCall(call, index));
}

// ─── Per-hop encoders ─────────────────────────────────────────

const CALLBACK_PROTOCOL_UNISWAP_V3 = 1;
const CALLBACK_PROTOCOL_SUSHISWAP_V3 = 2;
const CALLBACK_PROTOCOL_QUICKSWAP_V3 = 3;
const CALLBACK_PROTOCOL_KYBER_ELASTIC = 4;
const BPS_DENOMINATOR = 10_000;
const MAX_UINT24 = 16_777_215n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function normalizeBytes32(value: unknown) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
}

function callbackProtocolId(protocol: unknown) {
  switch (protocol) {
    case "UNISWAP_V3":
      return CALLBACK_PROTOCOL_UNISWAP_V3;
    case "SUSHISWAP_V3":
      return CALLBACK_PROTOCOL_SUSHISWAP_V3;
    case "QUICKSWAP_V3":
      return CALLBACK_PROTOCOL_QUICKSWAP_V3;
    case "KYBERSWAP_ELASTIC":
      return CALLBACK_PROTOCOL_KYBER_ELASTIC;
    default:
      throw new Error(`encodeV3Hop: unsupported callback protocol ${protocol}`);
  }
}

function poolTokensFromHop(hop: CalldataHop) {
  return hop.zeroForOne
    ? { token0: asAddress(hop.tokenIn), token1: asAddress(hop.tokenOut) }
    : { token0: asAddress(hop.tokenOut), token1: asAddress(hop.tokenIn) };
}

function deriveTightV3PriceLimit(hop: CalldataHop, amountIn: bigint, expectedAmountOut: bigint, fee: number, label: string) {
  const state = asRecord(hop.stateRef);
  let sqrtBefore: bigint;
  let liquidity: bigint;
  try {
    sqrtBefore = normalizeUint(state.sqrtPriceX96, `${label} stateRef.sqrtPriceX96`);
    liquidity = normalizeUint(state.liquidity, `${label} stateRef.liquidity`);
  } catch {
    throw new Error(`${label}: stateRef with valid sqrtPriceX96/liquidity required for tight price limit`);
  }
  if (sqrtBefore <= MIN_SQRT_RATIO || sqrtBefore >= MAX_SQRT_RATIO || liquidity <= 0n) {
    throw new Error(`${label}: stateRef with valid sqrtPriceX96/liquidity required for tight price limit`);
  }

  const simulated = simulateV3Swap(state, amountIn, Boolean(hop.zeroForOne), fee);
  if (simulated.amountOut !== expectedAmountOut) {
    throw new Error(`${label}: simulated amountOut mismatch for price limit`);
  }
  const sqrtAfter = simulated.sqrtPriceX96After;
  const movedInExpectedDirection = hop.zeroForOne
    ? sqrtAfter < sqrtBefore && sqrtAfter > MIN_SQRT_RATIO
    : sqrtAfter > sqrtBefore && sqrtAfter < MAX_SQRT_RATIO;
  if (!movedInExpectedDirection) {
    throw new Error(`${label}: unable to derive price limit from simulated state`);
  }
  // Apply 0.1% slippage buffer to the post-swap price limit so that minor
  // on-chain state changes between simulation and execution don't revert.
  // ZeroForOne (decreasing price): buffer lower = multiply by 0.999
  // !ZeroForOne (increasing price): buffer higher = multiply by 1.001
  const SLIPPAGE_BPS = 10n; // 0.1%
  const BPS_DENOM = 10_000n;
  const sqrtPriceLimitX96 = hop.zeroForOne
    ? (sqrtAfter * (BPS_DENOM - SLIPPAGE_BPS)) / BPS_DENOM
    : (sqrtAfter * (BPS_DENOM + SLIPPAGE_BPS)) / BPS_DENOM;
  return sqrtPriceLimitX96;
}

function normalizeUint(value: unknown, label: string) {
  try {
    const normalized = BigInt(value as BigNumberish);
    if (normalized < 0n) throw new Error("negative");
    return normalized;
  } catch {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function normalizePositiveUint(value: unknown, label: string) {
  const normalized = normalizeUint(value, label);
  if (normalized <= 0n) {
    throw new Error(`${label} must be > 0`);
  }
  return normalized;
}

function normalizeUint24(value: unknown, label: string) {
  const normalized = normalizeUint(value, label);
  if (normalized > MAX_UINT24) {
    throw new Error(`${label} must fit uint24`);
  }
  return Number(normalized);
}

function normalizeSlippageBps(value: unknown, label = "slippageBps") {
  const normalized = Number(value ?? 50);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > BPS_DENOMINATOR) {
    throw new Error(`${label} must be an integer between 0 and 10000`);
  }
  return normalized;
}

function slippageAdjustedAmountOut(amountOut: unknown, slippageBps: unknown, label: string) {
  const output = normalizePositiveUint(amountOut, `${label} amountOut`);
  const bps = normalizeSlippageBps(slippageBps, `${label} slippageBps`);
  const minimumOutput = (output * BigInt(BPS_DENOMINATOR - bps)) / BigInt(BPS_DENOMINATOR);
  if (minimumOutput <= 0n) {
    throw new Error(`${label} minimum output must be > 0`);
  }
  return minimumOutput;
}

function encodeDynamicApprovalCall(executor: string, token: string, spender: string, amount: bigint) {
  const approvalAmount = normalizeUint(amount, "approval amount");
  return {
    target: getAddress(executor),
    value: 0n,
    data: encodeFunctionData({
      abi: EXECUTOR_APPROVE_IF_NEEDED_ABI,
      functionName: "approveIfNeeded",
      args: [getAddress(token), getAddress(spender), approvalAmount],
    }),
  };
}

/**
 * Encode a V2 direct pair swap (transfer-first pattern).
 *
 * @param {Object} hop
 * @param {string} hop.poolAddress   Pair contract address
 * @param {string} hop.tokenIn       Input token address
 * @param {string} hop.tokenOut      Output token address
 * @param {boolean} hop.zeroForOne   Swap direction
 * @param {bigint} hop.amountIn      Input amount
 * @param {bigint} hop.amountOut     Expected output amount
 * @param {string} recipient         Address to receive output tokens
 * @param {Object} [options]
 * @param {number} [options.slippageBps=50]  Slippage tolerance in basis points
 * @returns {Array<{target: string, value: bigint, data: string}>}  1-2 Call structs
 */
export function encodeV2Hop(hop: CalldataHop, recipient: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const pair = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeV2Hop amountIn");
  // Fix #6: use caller-supplied slippageBps via shared helper instead of hardcoded 9950/10000
  const minAmountOut = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeV2Hop");
  const calls: ExecutorCall[] = [];

  // Call 1: Transfer input tokens to the pair
  const transferData = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [pair, amountIn],
  });

  calls.push({
    target: tokenIn,
    value: 0n,
    data: transferData,
  });

  // Call 2: Execute the swap
  // V2 swap: if zeroForOne, we want amount1Out; if !zeroForOne, we want amount0Out
  const amount0Out = hop.zeroForOne ? 0n : minAmountOut;
  const amount1Out = hop.zeroForOne ? minAmountOut : 0n;

  const swapData = encodeFunctionData({
    abi: V2_PAIR_SWAP_ABI,
    functionName: "swap",
    args: [amount0Out, amount1Out, asAddress(recipient), "0x"],
  });

  calls.push({
    target: pair,
    value: 0n,
    data: swapData,
  });

  return calls;
}

/**
 * Encode a V3 direct pool swap (callback-based payment).
 *
 * @param {Object} hop
 * @param {string} hop.poolAddress   Pool contract address
 * @param {string} hop.tokenIn       Input token address
 * @param {string} hop.tokenOut      Output token address
 * @param {boolean} hop.zeroForOne   Swap direction
 * @param {bigint} hop.amountIn      Input amount
 * @param {bigint} hop.amountOut     Expected output (used for slippage check if needed)
 * @param {string} recipient         Address to receive output tokens
 * @param {Object} [options]
 * @returns {Array<{target: string, value: bigint, data: string}>}  1 Call struct
 */
export function encodeV3Hop(hop: CalldataHop, recipient: string): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const { token0, token1 } = poolTokensFromHop(hop);

  // amountSpecified: positive for exact input
  const amountSpecified = normalizePositiveUint(hop.amountIn, "encodeV3Hop amountIn");
  const amountOut = normalizePositiveUint(hop.amountOut, "encodeV3Hop amountOut");
  const fee = normalizeUint24(hop.fee ?? 0, "encodeV3Hop fee");

  // sqrtPriceLimitX96: fail closed to the exact simulated post-swap price
  // instead of protocol extremes, so execution cannot move materially beyond
  // the off-chain simulation used for profitability/slippage decisions.
  const sqrtPriceLimitX96 = deriveTightV3PriceLimit(hop, amountSpecified, amountOut, fee, "encodeV3Hop");

  // Callback data is rich enough for the executor to authenticate the pool caller.
  const callbackData = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "protocolId", type: "uint8" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
        ],
      },
    ],
    [
      {
        protocolId: callbackProtocolId(hop.protocol),
        token0,
        token1,
        fee,
      },
    ],
  );

  const swapData = encodeFunctionData({
    abi: V3_POOL_SWAP_ABI,
    functionName: "swap",
    args: [asAddress(recipient), Boolean(hop.zeroForOne), amountSpecified, sqrtPriceLimitX96, callbackData],
  });

  return [
    {
      target: pool,
      value: 0n,
      data: swapData,
    },
  ];
}

/**
 * Resolve the fee value for a KyberSwap Elastic hop in parts-per-million (pips),
 * which is what simulateV3Swap and deriveTightV3PriceLimit expect.
 *
 * Kyber stores fees as "swapFeeBps" (BPS, e.g. 8 = 0.08%) on the pool record
 * and as "fee" in pips (e.g. 800) in the pool state/metadata. The fix is:
 *   - hop.swapFeeBps / hop.kyberSwapFeeBps: value is in BPS → convert to pips (*100)
 *   - hop.fee: already in pips (same unit as Uniswap V3 fee tiers) → use directly
 *
 * Previously the fallback branch multiplied hop.fee by 100 assuming it was in
 * BPS, but hop.fee for V3-family pools is always stored in pips. This caused
 * deriveTightV3PriceLimit to use a fee 100× too large, producing a wrong
 * sqrtPriceLimitX96 and on-chain reverts.
 */
function normalizeKyberSwapFeePips(hop: CalldataHop): number {
  const metadata = asRecord(hop.metadata);

  // Prefer the explicit BPS fields — convert BPS → pips for simulateV3Swap.
  const explicitBps = hop.swapFeeBps ?? hop.kyberSwapFeeBps ?? metadata.swapFeeBps;
  if (explicitBps != null) {
    const feeBps = normalizeUint(explicitBps, "encodeKyberElasticHop swapFeeBps");
    if (feeBps > 10_000n) {
      throw new Error("encodeKyberElasticHop swapFeeBps must be <= 10000");
    }
    const feePips = feeBps * 100n; // BPS → pips
    if (feePips > MAX_UINT24) {
      throw new Error("encodeKyberElasticHop fee in pips must fit uint24");
    }
    return Number(feePips);
  }

  // hop.fee is in pips (same convention as Uniswap V3: 3000 = 0.3%).
  // Do NOT multiply by 100 here — it is already in pips.
  const feePips = normalizeUint(hop.fee ?? 0, "encodeKyberElasticHop fee");
  if (feePips > MAX_UINT24) {
    throw new Error("encodeKyberElasticHop fee in pips must fit uint24");
  }
  return Number(feePips);
}

/**
 * Encode a KyberSwap Elastic direct pool swap.
 */
export function encodeKyberElasticHop(hop: CalldataHop, recipient: string): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const { token0, token1 } = poolTokensFromHop(hop);
  const amountSpecified = normalizePositiveUint(hop.amountIn, "encodeKyberElasticHop amountIn");
  const isToken0 = Boolean(hop.zeroForOne);
  const swapFeeBps = normalizeKyberSwapFeePips(hop);
  // Simulate the swap to get the exact expected amountOut for tight price limit derivation.
  const simulated = simulateV3Swap(hop.stateRef, amountSpecified, isToken0, swapFeeBps);
  const amountOut = simulated.amountOut;
  const sqrtPriceLimitX96 = deriveTightV3PriceLimit(hop, amountSpecified, amountOut, swapFeeBps, "encodeKyberElasticHop");

  const callbackData = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "protocolId", type: "uint8" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
        ],
      },
    ],
    [
      {
        protocolId: callbackProtocolId("KYBERSWAP_ELASTIC"),
        token0,
        token1,
        fee: swapFeeBps,
      },
    ],
  );

  const swapData = encodeFunctionData({
    abi: KYBER_ELASTIC_POOL_SWAP_ABI,
    functionName: "swap",
    args: [asAddress(recipient), amountSpecified, isToken0, sqrtPriceLimitX96, callbackData],
  });

  return [
    {
      target: pool,
      value: 0n,
      data: swapData,
    },
  ];
}

/**
 * Encode a DODO V2 direct pool swap (transfer-first pattern).
 */
export function encodeDodoHop(hop: CalldataHop, recipient: string): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeDodoHop amountIn");
  normalizePositiveUint(hop.amountOut, "encodeDodoHop amountOut");
  const calls: ExecutorCall[] = [];

  calls.push({
    target: tokenIn,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [pool, amountIn],
    }),
  });

  calls.push({
    target: pool,
    value: 0n,
    data: encodeFunctionData({
      abi: hop.zeroForOne ? DODO_SELL_BASE_ABI : DODO_SELL_QUOTE_ABI,
      functionName: hop.zeroForOne ? "sellBase" : "sellQuote",
      args: [asAddress(recipient)],
    }),
  });

  return calls;
}

/**
 * Encode a WOOFi WooRouterV2 swap.
 */
export function encodeWoofiHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const metadata = asRecord(hop.metadata);
  const router = asAddress(hop.router ?? metadata.router ?? WOOFI_ROUTER_V2);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenOut = asAddress(hop.tokenOut);
  const exec = asAddress(executor);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeWoofiHop amountIn");
  const minToAmount = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeWoofiHop");

  return [
    encodeDynamicApprovalCall(exec, tokenIn, router, amountIn),
    {
      target: router,
      value: 0n,
      data: encodeFunctionData({
        abi: WOOFI_ROUTER_SWAP_ABI,
        functionName: "swap",
        args: [tokenIn, tokenOut, amountIn, minToAmount, exec, ZERO_ADDRESS],
      }),
    },
  ];
}

/**
 * Encode a Curve pool swap via exchange().
 */
export function encodeCurveHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const pool = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenInIdx = Number(hop.tokenInIdx);
  const tokenOutIdx = Number(hop.tokenOutIdx);

  if (!Number.isInteger(tokenInIdx) || tokenInIdx < 0) {
    throw new Error(`encodeCurveHop: tokenInIdx required for pool ${hop.poolAddress}`);
  }
  if (!Number.isInteger(tokenOutIdx) || tokenOutIdx < 0) {
    throw new Error(`encodeCurveHop: tokenOutIdx required for pool ${hop.poolAddress}`);
  }
  if (tokenInIdx === tokenOutIdx) {
    throw new Error(`encodeCurveHop: token indices must differ for pool ${hop.poolAddress}`);
  }

  // Apply slippage to minimum output
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeCurveHop amountIn");
  const minDy = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeCurveHop");

  const calls: ExecutorCall[] = [];

  // Call 1: Ensure the pool can pull tokenIn from the executor.
  calls.push(encodeDynamicApprovalCall(executor, tokenIn, pool, amountIn));

  // Call 2: Execute the exchange
  const proto = String(hop.protocol ?? "");

  if (proto === "CURVE_STABLESWAP_NG") {
    calls.push({
      target: pool,
      value: 0n,
      data: encodeFunctionData({
        abi: CURVE_EXCHANGE_INT128_RECEIVER_ABI,
        functionName: "exchange",
        args: [tokenInIdx, tokenOutIdx, amountIn, minDy, executor],
      }),
    });
  } else if (hop.isCrypto) {
    calls.push({
      target: pool,
      value: 0n,
      data: encodeFunctionData({
        abi: CURVE_EXCHANGE_UINT256_ABI,
        functionName: "exchange",
        args: [BigInt(tokenInIdx), BigInt(tokenOutIdx), amountIn, minDy],
      }),
    });
  } else {
    calls.push({
      target: pool,
      value: 0n,
      data: encodeFunctionData({
        abi: CURVE_EXCHANGE_INT128_ABI,
        functionName: "exchange",
        args: [tokenInIdx, tokenOutIdx, amountIn, minDy],
      }),
    });
  }

  return calls;
}

/**
 * Encode a Balancer V2 single-pool swap via Vault.swap().
 */
export function encodeBalancerHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50, deadline } = options;
  const poolId = normalizeBytes32(hop.poolId);

  if (!poolId) {
    throw new Error(`encodeBalancerHop: poolId required for pool ${hop.poolAddress}`);
  }
  if (deadline == null) {
    throw new Error(`encodeBalancerHop: deadline required for pool ${hop.poolAddress}`);
  }

  const vault = asAddress(BALANCER_VAULT);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenOut = asAddress(hop.tokenOut);
  const exec = asAddress(executor);

  // Minimum acceptable output with slippage
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeBalancerHop amountIn");
  const limit = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeBalancerHop");

  const calls: ExecutorCall[] = [];

  // Call 1: Ensure the Vault can pull tokenIn from the executor.
  calls.push(encodeDynamicApprovalCall(exec, tokenIn, vault, amountIn));

  // Call 2: Vault.swap
  calls.push({
    target: vault,
    value: 0n,
    data: encodeFunctionData({
      abi: BALANCER_VAULT_SWAP_ABI,
      functionName: "swap",
      args: [
        // SingleSwap
        {
          poolId,
          kind: 0, // GIVEN_IN
          assetIn: tokenIn,
          assetOut: tokenOut,
          amount: amountIn,
          userData: "0x",
        },
        // FundManagement
        {
          sender: exec,
          fromInternalBalance: false,
          recipient: exec,
          toInternalBalance: false,
        },
        limit,
        deadline,
      ],
    }),
  });

  return calls;
}

// ─── Route encoder ────────────────────────────────────────────

/**
 * Encode a complete multi-hop route into a Call[] array.
 */
export function encodeRoute(route: CalldataRoute, executorAddress: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { path, result } = route;
  const executor = asAddress(executorAddress);
  const calls: ExecutorCall[] = [];

  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];
    const amountIn = result.hopAmounts[i];
    const amountOut = result.hopAmounts[i + 1];
    const proto = normalizeProtocolKey(edge.protocol);

    const meta = asRecord(edge.metadata);

    const hop = {
      protocol: proto,
      poolAddress: edge.poolAddress,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      zeroForOne: edge.zeroForOne,
      amountIn,
      amountOut,
      fee: edge.fee ?? meta.fee ?? 0,
      swapFeeBps: edge.swapFeeBps ?? meta.swapFeeBps,
      router: meta.router,
      metadata: meta,
      stateRef: edge.stateRef,
      tokenInIdx: edge.tokenInIdx ?? meta.tokenInIdx ?? (edge.zeroForOne ? 0 : 1),
      tokenOutIdx: edge.tokenOutIdx ?? meta.tokenOutIdx ?? (edge.zeroForOne ? 1 : 0),
      isCrypto: CURVE_CRYPTO_PROTOCOLS.has(proto),
      poolId: normalizeBytes32(
        meta.poolId ?? meta.pool_id ?? edge.poolId ?? asRecord(edge.stateRef).balancerPoolId ?? asRecord(edge.stateRef).poolId,
      ),
    };

    if (DIRECT_SWAP_PROTOCOLS.has(proto)) {
      calls.push(...encodeV2Hop(hop, executor, options));
    } else if (proto === "KYBERSWAP_ELASTIC") {
      calls.push(...encodeKyberElasticHop(hop, executor));
    } else if (DODO_PROTOCOLS.has(proto)) {
      calls.push(...encodeDodoHop(hop, executor));
    } else if (WOOFI_PROTOCOLS.has(proto)) {
      calls.push(...encodeWoofiHop(hop, executor, options));
    } else if (V3_SWAP_PROTOCOLS().has(proto)) {
      calls.push(...encodeV3Hop(hop, executor));
    } else if (CURVE_STABLE_PROTOCOLS.has(proto) || CURVE_CRYPTO_PROTOCOLS.has(proto)) {
      calls.push(...encodeCurveHop(hop, executor, options));
    } else if (BALANCER_PROTOCOLS.has(proto)) {
      calls.push(...encodeBalancerHop(hop, executor, options));
    } else {
      throw new Error(`Unsupported protocol for execution: ${proto} at hop ${i}`);
    }
  }

  return calls;
}

// ─── Route hash ───────────────────────────────────────────────

/**
 * Compute the routeHash for a Call[] array.
 *
 * Must match Solidity exactly: keccak256(abi.encode(calls)) where
 * `calls` is `Call[]` and `Call` is `(address target,uint256 value,bytes data)`.
 */
export function computeRouteHash(calls: unknown) {
  const normalizedCalls = normalizeExecutorCalls(calls);
  const encoded = encodeAbiParameters(CALL_STRUCT_ARRAY_ABI, [
    normalizedCalls.map((c) => ({ target: c.target, value: c.value, data: c.data })),
  ]);

  return keccak256(encoded);
}

// ─── FlashParams builder ──────────────────────────────────────

/**
 * Build the complete FlashParams struct.
 */
export function buildFlashParams({ profitToken, minProfit, deadline, calls }: FlashParamsInput) {
  const normalizedCalls = normalizeExecutorCalls(calls);
  const routeHash = computeRouteHash(normalizedCalls);

  return {
    profitToken: getAddress(profitToken),
    minProfit,
    deadline,
    routeHash,
    calls: normalizedCalls,
  };
}

// ─── Top-level transaction encoder ────────────────────────────

/**
 * Encode the complete executeArb transaction calldata.
 */
export function encodeExecuteArb({ executorAddress, flashToken, flashAmount, profitToken, minProfit, deadline, calls }: ExecuteArbInput) {
  const flashParams = buildFlashParams({
    profitToken,
    minProfit,
    deadline,
    calls,
  });

  const data = encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: "executeArb",
    args: [getAddress(flashToken), flashAmount, flashParams],
  });

  return {
    to: getAddress(executorAddress),
    data,
    value: 0n,
  };
}
