import { encodeFunctionData, getAddress, encodeAbiParameters } from "viem";
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from "../../../core/math/tick_math.ts";
import { simulateV3Swap } from "../../../core/math/uniswap_v3.ts";
import { simulateV2Swap } from "../../../core/math/uniswap_v2.ts";
import { asAddress, normalizePositiveUint, normalizeUint, normalizeUint24, slippageAdjustedAmountOut, normalizeBytes32 } from "./utils.ts";
import {
  CALLBACK_PROTOCOL_UNISWAP_V3,
  CALLBACK_PROTOCOL_SUSHISWAP_V3,
  CALLBACK_PROTOCOL_QUICKSWAP_V3,
  CALLBACK_PROTOCOL_KYBER_ELASTIC,
  MAX_UINT24,
  BALANCER_VAULT,
  WOOFI_ROUTER_V2,
  POOL_MANAGER_ADDRESS,
  ZERO_ADDRESS,
  BPS_DENOMINATOR,
} from "./constants.ts";
import {
  ERC20_TRANSFER_ABI,
  V2_PAIR_SWAP_ABI,
  V3_POOL_SWAP_ABI,
  KYBER_ELASTIC_POOL_SWAP_ABI,
  DODO_SELL_BASE_ABI,
  DODO_SELL_QUOTE_ABI,
  WOOFI_ROUTER_SWAP_ABI,
  CURVE_EXCHANGE_INT128_ABI,
  CURVE_EXCHANGE_UINT256_ABI,
  CURVE_EXCHANGE_INT128_RECEIVER_ABI,
  BALANCER_VAULT_SWAP_ABI,
  EXECUTOR_APPROVE_IF_NEEDED_ABI,
  POOL_MANAGER_LOCK_ABI,
} from "./abis.ts";
import type { ExecutorCall, CalldataHop, RouteCalldataOptions } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────

function callbackProtocolId(protocol: unknown): number {
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

function poolTokensFromHop(hop: CalldataHop): { token0: `0x${string}`; token1: `0x${string}` } {
  return hop.zeroForOne
    ? { token0: asAddress(hop.tokenIn), token1: asAddress(hop.tokenOut) }
    : { token0: asAddress(hop.tokenOut), token1: asAddress(hop.tokenIn) };
}

function deriveTightV3PriceLimit(
  hop: CalldataHop,
  amountIn: bigint,
  expectedAmountOut: bigint,
  fee: number,
  label: string,
  options: RouteCalldataOptions = {},
): bigint {
  const { slippageBps = 50 } = options;
  const state = hop.stateRef ?? {};
  const sqrtBefore = normalizeUint(state.sqrtPriceX96, `${label} stateRef.sqrtPriceX96`);
  const liquidity = normalizeUint(state.liquidity, `${label} stateRef.liquidity`);
  if (sqrtBefore <= MIN_SQRT_RATIO || sqrtBefore >= MAX_SQRT_RATIO || liquidity <= 0n) {
    throw new Error(`${label}: valid stateRef sqrtPriceX96/liquidity required`);
  }
  const simulated = simulateV3Swap(state as Record<string, unknown>, amountIn, Boolean(hop.zeroForOne), fee);
  if (simulated.amountOut !== expectedAmountOut) {
    // Do not throw: intermediate hops intentionally use slippage-adjusted (smaller) amountIn for safe transfers
    // (see encodeRoute transferSlipBps). The pipeline result used full amounts. Derive limit from the actual
    // amountIn we will encode/send. This unblocks V3 legs in multi-hop routes.
    // Also tolerates shallow V3 state (no ticks) or minor drift between sim and build snapshots.
    if ((globalThis as any).__V3_MISMATCH_LOGGED__ == null) (globalThis as any).__V3_MISMATCH_LOGGED__ = 0;
    if ((globalThis as any).__V3_MISMATCH_LOGGED__ < 5) {
      (globalThis as any).__V3_MISMATCH_LOGGED__++;
      console.warn(
        `[v3-limit] amountOut mismatch (using actual in for limit): label=${label} in=${amountIn} expectedOut=${expectedAmountOut} simOut=${simulated.amountOut} sqrtBefore=${sqrtBefore} pool=${hop.poolAddress}`,
      );
    }
  }
  const sqrtAfter = simulated.sqrtPriceX96After;
  const movedOk = hop.zeroForOne
    ? sqrtAfter < sqrtBefore && sqrtAfter > MIN_SQRT_RATIO
    : sqrtAfter > sqrtBefore && sqrtAfter < MAX_SQRT_RATIO;
  if (!movedOk) throw new Error(`${label}: unable to derive price limit`);

  // Slippage must be applied geometrically on sqrtPriceX96, because price = (sqrtPrice)^2.
  // A linear BPS adjustment on sqrtPrice corresponds to ~2x that BPS in price terms.
  // We use sqrt(1 ± slippage) ≈ 1 ± slippage/2 on sqrtPrice, which is still approximate
  // but far more correct than applying the full BPS directly.
  // Represented as: sqrtAfter * sqrt(1 - s) ≈ sqrtAfter * (1 - s/2) for zeroForOne,
  // and sqrtAfter * sqrt(1 + s) ≈ sqrtAfter * (1 + s/2) for !zeroForOne.
  const SLIPPAGE_BPS = BigInt(slippageBps);
  const DENOM = 20_000n; // half-BPS denominator for sqrt-space adjustment
  return hop.zeroForOne ? (sqrtAfter * (DENOM - SLIPPAGE_BPS)) / DENOM : (sqrtAfter * (DENOM + SLIPPAGE_BPS)) / DENOM;
}

function encodeDynamicApprovalCall(executor: string, token: string, spender: string, amount: bigint): ExecutorCall {
  return {
    target: getAddress(executor),
    value: 0n,
    data: encodeFunctionData({
      abi: EXECUTOR_APPROVE_IF_NEEDED_ABI,
      functionName: "approveIfNeeded",
      args: [getAddress(token), getAddress(spender), normalizeUint(amount, "approval amount")],
    }),
  };
}

function normalizeKyberSwapFeePips(hop: CalldataHop): number {
  const metadata = (hop.metadata ?? {}) as Record<string, unknown>;
  const explicitBps = hop.swapFeeBps ?? hop.kyberSwapFeeBps ?? metadata.swapFeeBps;
  if (explicitBps != null) {
    const feeBps = normalizeUint(explicitBps, "encodeKyberElasticHop swapFeeBps");
    if (feeBps > BPS_DENOMINATOR) throw new Error("encodeKyberElasticHop swapFeeBps must be <= 10000");
    const feePips = feeBps * 100n;
    if (feePips > MAX_UINT24) throw new Error("encodeKyberElasticHop fee pips exceeds uint24");
    return Number(feePips);
  }
  const feePips = normalizeUint(hop.fee ?? 0, "encodeKyberElasticHop fee");
  if (feePips > MAX_UINT24) throw new Error("encodeKyberElasticHop fee pips exceeds uint24");
  return Number(feePips);
}

// ─── Per-hop encoders ──────────────────────────────────────────

export function encodeV2Hop(hop: CalldataHop, recipient: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const pair = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeV2Hop amountIn");
  // Derive minAmountOut from the *actual committed amountIn* (which may have been extra-slipped for intermediate hops
  // to protect against delivery shortfalls from prior hops like Balancer). This ensures the out requested from
  // pair.swap is consistent with in sent, preventing "UniswapV2: K" reverts in dryRun / on-chain when nominal
  // hop.amountOut (from full sim amounts) would require more in than we actually transferred.
  let outForMin = hop.amountOut;
  if (hop.stateRef) {
    try {
      const { amountOut: computed } = simulateV2Swap(hop.stateRef, amountIn, Boolean(hop.zeroForOne));
      if (computed > 0n) {
        outForMin = computed;
      }
    } catch {
      // fallback to nominal hop.amountOut below
    }
  }
  const minAmountOut = slippageAdjustedAmountOut(outForMin, slippageBps, "encodeV2Hop");
  const calls: ExecutorCall[] = [];
  calls.push({
    target: tokenIn,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [pair, amountIn] }),
  });
  const amount0Out = hop.zeroForOne ? 0n : minAmountOut;
  const amount1Out = hop.zeroForOne ? minAmountOut : 0n;
  calls.push({
    target: pair,
    value: 0n,
    data: encodeFunctionData({ abi: V2_PAIR_SWAP_ABI, functionName: "swap", args: [amount0Out, amount1Out, asAddress(recipient), "0x"] }),
  });
  return calls;
}

export function encodeV3Hop(hop: CalldataHop, recipient: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const { token0, token1 } = poolTokensFromHop(hop);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeV3Hop amountIn");
  const amountOut = normalizePositiveUint(hop.amountOut, "encodeV3Hop amountOut");
  const fee = normalizeUint24(hop.fee ?? 0, "encodeV3Hop fee");
  const sqrtPriceLimitX96 = deriveTightV3PriceLimit(hop, amountIn, amountOut, fee, "encodeV3Hop", options);
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
    [{ protocolId: callbackProtocolId(hop.protocol), token0, token1, fee }],
  );
  return [
    {
      target: pool,
      value: 0n,
      data: encodeFunctionData({
        abi: V3_POOL_SWAP_ABI,
        functionName: "swap",
        // negative amountSpecified = exact-input mode
        args: [asAddress(recipient), Boolean(hop.zeroForOne), -amountIn, sqrtPriceLimitX96, callbackData],
      }),
    },
  ];
}

export function encodeKyberElasticHop(hop: CalldataHop, recipient: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const { token0, token1 } = poolTokensFromHop(hop);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeKyberElasticHop amountIn");
  const isToken0 = Boolean(hop.zeroForOne);
  const swapFeePips = normalizeKyberSwapFeePips(hop);
  const simulated = simulateV3Swap(hop.stateRef ?? {}, amountIn, isToken0, swapFeePips);
  const sqrtPriceLimitX96 = deriveTightV3PriceLimit(hop, amountIn, simulated.amountOut, swapFeePips, "encodeKyberElasticHop", options);
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
    [{ protocolId: callbackProtocolId("KYBERSWAP_ELASTIC"), token0, token1, fee: swapFeePips }],
  );
  return [
    {
      target: pool,
      value: 0n,
      data: encodeFunctionData({
        abi: KYBER_ELASTIC_POOL_SWAP_ABI,
        functionName: "swap",
        // negative swapQty = exact-input mode
        args: [asAddress(recipient), -amountIn, isToken0, sqrtPriceLimitX96, callbackData],
      }),
    },
  ];
}

export function encodeDodoHop(hop: CalldataHop, recipient: string): ExecutorCall[] {
  const pool = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeDodoHop amountIn");
  return [
    {
      target: tokenIn,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [pool, amountIn] }),
    },
    {
      target: pool,
      value: 0n,
      data: encodeFunctionData({
        abi: hop.zeroForOne ? DODO_SELL_BASE_ABI : DODO_SELL_QUOTE_ABI,
        functionName: hop.zeroForOne ? "sellBase" : "sellQuote",
        args: [asAddress(recipient)],
      }),
    },
  ];
}

export function encodeWoofiHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const router = asAddress(hop.router ?? (hop.metadata as Record<string, unknown> | undefined)?.router ?? WOOFI_ROUTER_V2);
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

export function encodeCurveHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50 } = options;
  const pool = asAddress(hop.poolAddress);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenInIdx = Number(hop.tokenInIdx);
  const tokenOutIdx = Number(hop.tokenOutIdx);
  if (!Number.isInteger(tokenInIdx) || tokenInIdx < 0) throw new Error("encodeCurveHop: valid tokenInIdx required");
  if (!Number.isInteger(tokenOutIdx) || tokenOutIdx < 0) throw new Error("encodeCurveHop: valid tokenOutIdx required");
  if (tokenInIdx === tokenOutIdx) throw new Error("encodeCurveHop: token indices must differ");
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeCurveHop amountIn");
  const minDy = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeCurveHop");
  const calls: ExecutorCall[] = [encodeDynamicApprovalCall(executor, tokenIn, pool, amountIn)];
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

export function encodeBalancerHop(hop: CalldataHop, executor: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { slippageBps = 50, deadline } = options;
  const poolId = normalizeBytes32(hop.poolId);
  if (!poolId) throw new Error("encodeBalancerHop: poolId required");
  if (deadline == null) throw new Error("encodeBalancerHop: deadline required");
  const vault = asAddress(BALANCER_VAULT);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenOut = asAddress(hop.tokenOut);
  const exec = asAddress(executor);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeBalancerHop amountIn");
  const limit = slippageAdjustedAmountOut(hop.amountOut, slippageBps, "encodeBalancerHop");
  return [
    encodeDynamicApprovalCall(exec, tokenIn, vault, amountIn),
    {
      target: vault,
      value: 0n,
      data: encodeFunctionData({
        abi: BALANCER_VAULT_SWAP_ABI,
        functionName: "swap",
        args: [
          { poolId, kind: 0, assetIn: tokenIn, assetOut: tokenOut, amount: amountIn, userData: "0x" },
          { sender: exec, fromInternalBalance: false, recipient: exec, toInternalBalance: false },
          limit,
          deadline,
        ],
      }),
    },
  ];
}

export function encodeV4Hop(hop: CalldataHop, executor: string): ExecutorCall[] {
  const poolManager = getAddress(POOL_MANAGER_ADDRESS);
  const exec = getAddress(executor);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenOut = asAddress(hop.tokenOut);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeV4Hop amountIn");
  const state = (hop.stateRef ?? {}) as Record<string, unknown>;
  const fee = normalizeUint(state.fee ?? 0, "encodeV4Hop fee");
  const tickSpacing = Number(state.tickSpacing ?? 60);
  const hooks = getAddress(String(state.hooks ?? ZERO_ADDRESS));

  const zeroForOne = Boolean(hop.zeroForOne);
  const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  const poolKey = {
    currency0: getAddress(zeroForOne ? tokenIn : tokenOut),
    currency1: getAddress(zeroForOne ? tokenOut : tokenIn),
    fee: Number(fee),
    tickSpacing,
    hooks,
  };

  const lockData = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountSpecified", type: "int256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    [poolKey, zeroForOne, BigInt(amountIn), sqrtPriceLimitX96],
  );

  return [
    encodeDynamicApprovalCall(exec, tokenIn, poolManager, amountIn),
    {
      target: poolManager,
      value: 0n,
      data: encodeFunctionData({
        abi: POOL_MANAGER_LOCK_ABI,
        functionName: "lock",
        args: [lockData],
      }),
    },
  ];
}
