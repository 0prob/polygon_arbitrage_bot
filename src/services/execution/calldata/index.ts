import { getAddress, encodeFunctionData, encodeAbiParameters, keccak256 } from "viem";
import { normalizeUint, normalizeBytes32, asAddress } from "./utils.ts";
import {
  V2_PROTOCOLS,
  CURVE_STABLE_PROTOCOLS,
  CURVE_CRYPTO_PROTOCOLS,
  DODO_PROTOCOLS,
  WOOFI_PROTOCOLS,
  BALANCER_PROTOCOLS,
} from "./constants.ts";
import {
  encodeV2Hop,
  encodeV3Hop,
  encodeKyberElasticHop,
  encodeDodoHop,
  encodeWoofiHop,
  encodeCurveHop,
  encodeBalancerHop,
  encodeV4Hop,
} from "./hops.ts";
import { EXECUTOR_ABI, CALL_STRUCT_ARRAY_ABI, EXECUTOR_AAVE_ABI } from "./abis.ts";
import type { ExecutorCall, CalldataHop, CalldataRoute, RouteCalldataOptions, FlashParamsInput, ExecuteArbInput } from "./types.ts";

export type { ExecutorCall, CalldataHop, CalldataRoute, RouteCalldataOptions, FlashParamsInput, ExecuteArbInput };

function normalizeProtocolKey(protocol: unknown): string {
  if (typeof protocol === "string") return protocol.toUpperCase().replace(/\s+/g, "_");
  return String(protocol ?? "")
    .toUpperCase()
    .replace(/\s+/g, "_");
}

export function encodeRoute(route: CalldataRoute, executorAddress: string, options: RouteCalldataOptions = {}): ExecutorCall[] {
  const { path, result } = route;
  const executor = asAddress(executorAddress);
  const calls: ExecutorCall[] = [];
  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];
    const amountIn = result.hopAmounts[i];
    const amountOut = result.hopAmounts[i + 1];
    const proto = normalizeProtocolKey(edge.protocol);
    const meta = (edge.metadata ?? {}) as Record<string, unknown>;
    const hop: CalldataHop = {
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
        meta.poolId ??
          meta.pool_id ??
          edge.poolId ??
          (edge.stateRef as Record<string, unknown> | undefined)?.balancerPoolId ??
          (edge.stateRef as Record<string, unknown> | undefined)?.poolId,
      ),
    };
    if (V2_PROTOCOLS.has(proto)) {
      calls.push(...encodeV2Hop(hop, executor, options));
    } else if (proto === "KYBERSWAP_ELASTIC") {
      calls.push(...encodeKyberElasticHop(hop, executor));
    } else if (DODO_PROTOCOLS.has(proto)) {
      calls.push(...encodeDodoHop(hop, executor));
    } else if (WOOFI_PROTOCOLS.has(proto)) {
      calls.push(...encodeWoofiHop(hop, executor, options));
    } else if (proto.startsWith("UNISWAP_V3") || proto.startsWith("SUSHISWAP_V3") || proto.startsWith("QUICKSWAP_V3")) {
      calls.push(...encodeV3Hop(hop, executor));
    } else if (CURVE_STABLE_PROTOCOLS.has(proto) || CURVE_CRYPTO_PROTOCOLS.has(proto)) {
      calls.push(...encodeCurveHop(hop, executor, options));
    } else if (BALANCER_PROTOCOLS.has(proto)) {
      calls.push(...encodeBalancerHop(hop, executor, options));
    } else if (proto === "UNISWAP_V4") {
      calls.push(...encodeV4Hop(hop, executor));
    } else {
      throw new Error(`Unsupported protocol for execution: ${proto} at hop ${i}`);
    }
  }
  return calls;
}

function normalizeExecutorCalls(calls: unknown): ExecutorCall[] {
  if (!Array.isArray(calls)) throw new Error("executor calls must be an array");
  return calls.map((call, index) => {
    if (!call || typeof call !== "object") throw new Error(`executor call ${index} must be an object`);
    const r = call as { target?: unknown; value?: unknown; data?: unknown };
    const target = asAddress(r.target);
    const value = normalizeUint(r.value ?? 0n, `executor call ${index} value`);
    const data = typeof r.data === "string" ? r.data : "";
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
      throw new Error(`executor call ${index} data must be 0x-prefixed even-length hex`);
    }
    return { target, value, data: data.toLowerCase() as `0x${string}` };
  });
}

export function computeRouteHash(calls: unknown): `0x${string}` {
  const normalized = normalizeExecutorCalls(calls);
  const encoded = encodeAbiParameters(CALL_STRUCT_ARRAY_ABI, [normalized.map((c) => ({ target: c.target, value: c.value, data: c.data }))]);
  return keccak256(encoded);
}

export function buildFlashParams(input: FlashParamsInput) {
  const normalizedCalls = normalizeExecutorCalls(input.calls);
  const routeHash = computeRouteHash(normalizedCalls);
  return {
    profitToken: getAddress(input.profitToken),
    minProfit: input.minProfit,
    deadline: input.deadline,
    routeHash,
    calls: normalizedCalls,
  };
}

export function encodeExecuteArb(input: ExecuteArbInput) {
  const flashParams = buildFlashParams(input);
  const data = encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: "executeArb",
    args: [getAddress(input.flashToken), input.flashAmount, flashParams],
  });
  return { to: getAddress(input.executorAddress), data, value: 0n };
}

export function encodeExecuteArbWithAave(input: ExecuteArbInput) {
  const flashParams = buildFlashParams(input);
  const data = encodeFunctionData({
    abi: EXECUTOR_AAVE_ABI,
    functionName: "executeArbWithAave",
    args: [getAddress(input.flashToken), input.flashAmount, flashParams],
  });
  return { to: getAddress(input.executorAddress), data, value: 0n };
}
