import { keccak256, encodeAbiParameters, getAddress } from "viem";
import type { Address } from "viem";
import type { PoolState } from "../../core/types/pool.ts";
import { isInvalidState } from "../../core/types/pool.ts";
import { normalizeProtocol } from "../../pipeline/simulator.ts";
import { simulateV2Swap } from "../../core/math/uniswap_v2.ts";
import { simulateV3Swap } from "../../core/math/uniswap_v3.ts";
import { BPS_DENOM } from "../../core/constants.ts";
import type { StateOverride, BuildOverrideInput, OverrideProtocol, V4PoolKey } from "../../core/types/state-override.ts";
import { V4_POOLS_MAPPING_SLOT, DEFAULT_POOL_MANAGER_ADDRESS } from "../../core/types/state-override.ts";

const V2_RESERVE0_SLOT = 8n;
const V2_RESERVE1_SLOT = 9n;

const V3_SLOT0_SLOT = 0n;
const V3_LIQUIDITY_SLOT = 1n;

const DODO_BASE_RESERVE_SLOT = 0n;
const DODO_QUOTE_RESERVE_SLOT = 1n;

function toStorageValue(v: bigint): string {
  return `0x${v.toString(16).padStart(64, "0")}`;
}

function bigintFromState(state: PoolState, key: string, fallback = 0n): bigint {
  const raw = state[key] as bigint | undefined;
  return raw !== undefined && raw !== null ? BigInt(raw) : fallback;
}

function protocolClass(protocol: string): OverrideProtocol {
  const norm = normalizeProtocol(protocol);
  if (norm === "V4") return "V4";
  if (norm === "V3") return "V3";
  if (norm === "V2") return "V2";
  if (norm === "BALANCER") return "BALANCER";
  if (norm === "CURVE") return "CURVE";
  if (norm === "DODO") return "DODO";
  if (norm === "WOOFI") return "WOOFI";
  return "V2";
}

function computeV4PoolId(key: V4PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks] as [any, any, any, any, any],
    ),
  );
}

function computeV4StorageSlot(poolId: `0x${string}`, mappingSlot: bigint, offset: bigint): `0x${string}` {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }],
    [poolId, mappingSlot],
  );
  const base = keccak256(encoded);
  if (offset === 0n) return base;
  const sum = (BigInt(base) + offset) & ((1n << 256n) - 1n);
  return `0x${sum.toString(16).padStart(64, "0")}`;
}

function buildV2Override(input: BuildOverrideInput): StateOverride | null {
  const state = input.currentState;
  if (isInvalidState(state)) return null;

  const r0 = bigintFromState(state, "reserve0");
  const r1 = bigintFromState(state, "reserve1");
  if (r0 <= 0n || r1 <= 0n) return null;

  const feeBps = BigInt(input.swapFeeBps ?? 30);
  const feeNum = feeBps < 500n ? 1000n - (feeBps * 1000n) / BPS_DENOM : feeBps;
  const feeDen = 1000n;

  const isZFO = input.zeroForOne ?? true;
  const swap = simulateV2Swap(state, input.amountIn, isZFO, feeNum, feeDen);
  if (swap.amountOut <= 0n) return null;

  const newR0 = isZFO ? r0 + input.amountIn : r0 - swap.amountOut;
  const newR1 = isZFO ? r1 - swap.amountOut : r1 + input.amountIn;

  if (newR0 < 0n || newR1 < 0n) return null;

  const override: StateOverride = {};
  override[input.poolAddress] = {
    stateDiff: {
      [toStorageValue(V2_RESERVE0_SLOT)]: toStorageValue(newR0),
      [toStorageValue(V2_RESERVE1_SLOT)]: toStorageValue(newR1),
    },
  };
  return override;
}

function buildV3Override(input: BuildOverrideInput): StateOverride | null {
  const state = input.currentState;
  if (isInvalidState(state)) return null;

  const sqrtPriceX96 = bigintFromState(state, "sqrtPriceX96");
  if (sqrtPriceX96 <= 0n) return null;

  const fee = input.fee ?? Number(bigintFromState(state, "fee", 3000n));
  const swap = simulateV3Swap(state, input.amountIn, input.zeroForOne ?? true, fee);
  if (swap.amountOut <= 0n) return null;

  const unlocked = 1n; // true
  const observationCardinality = 1n;
  const observationCardinalityNext = 1n;
  const slot0Packed =
    (unlocked << 240n) |
    (observationCardinalityNext << 216n) |
    (observationCardinality << 200n) |
    ((BigInt(swap.tickAfter) & 0xFFFFFFn) << 160n) |
    swap.sqrtPriceX96After;
  const override: StateOverride = {};
  override[input.poolAddress] = {
    stateDiff: {
      [toStorageValue(V3_SLOT0_SLOT)]: toStorageValue(slot0Packed),
      [toStorageValue(V3_LIQUIDITY_SLOT)]: toStorageValue(bigintFromState(state, "liquidity")),
    },
  };
  return override;
}

function buildV4Override(input: BuildOverrideInput): StateOverride | null {
  const state = input.currentState;
  if (isInvalidState(state)) return null;

  const sqrtPriceX96 = bigintFromState(state, "sqrtPriceX96");
  if (sqrtPriceX96 <= 0n) return null;

  const fee = input.fee ?? Number(bigintFromState(state, "fee", 3000n));
  const swap = simulateV3Swap(state, input.amountIn, input.zeroForOne ?? true, fee);
  if (swap.amountOut <= 0n) return null;

  const tickSpacing = input.tickSpacing ?? Number(bigintFromState(state, "tickSpacing", 60n));
  const hooks = (input.hooks ?? "0x0000000000000000000000000000000000000000") as Address;
  const currency0 = (input.currency0 ?? input.tokenIn) as Address;
  const currency1 = (input.currency1 ?? input.tokenOut) as Address;
  const poolKey: V4PoolKey = {
    currency0: getAddress(currency0),
    currency1: getAddress(currency1),
    fee,
    tickSpacing,
    hooks: getAddress(hooks),
  };

  const poolId = computeV4PoolId(poolKey);
  const slotStorage = computeV4StorageSlot(poolId, V4_POOLS_MAPPING_SLOT, 0n);
  const liqStorage = computeV4StorageSlot(poolId, V4_POOLS_MAPPING_SLOT, 1n);

  const poolManagerAddress = (input.poolManagerAddress ?? DEFAULT_POOL_MANAGER_ADDRESS) as Address;
  const slot0Packed =
    ((BigInt(swap.tickAfter) & 0xFFFFFFn) << 160n) |
    swap.sqrtPriceX96After;

  const override: StateOverride = {};
  override[poolManagerAddress] = {
    stateDiff: {
      [slotStorage]: toStorageValue(slot0Packed),
      [liqStorage]: toStorageValue(bigintFromState(state, "liquidity")),
    },
  };
  return override;
}

function buildDodoOverride(input: BuildOverrideInput): StateOverride | null {
  const state = input.currentState;
  if (isInvalidState(state)) return null;

  const baseR = bigintFromState(state, "baseReserve");
  const quoteR = bigintFromState(state, "quoteReserve");
  if (baseR <= 0n || quoteR <= 0n) return null;

  const isZFO = input.zeroForOne ?? true;
  const newBase = isZFO ? baseR + input.amountIn : baseR;
  const newQuote = isZFO ? quoteR : quoteR + input.amountIn;

  if (newBase < 0n || newQuote < 0n) return null;

  const override: StateOverride = {};
  override[input.poolAddress] = {
    stateDiff: {
      [toStorageValue(DODO_BASE_RESERVE_SLOT)]: toStorageValue(newBase),
      [toStorageValue(DODO_QUOTE_RESERVE_SLOT)]: toStorageValue(newQuote),
    },
  };
  return override;
}

function buildBalancerOverride(_input: BuildOverrideInput): StateOverride | null {
  return null;
}

function buildCurveOverride(_input: BuildOverrideInput): StateOverride | null {
  return null;
}

function buildWoofiOverride(_input: BuildOverrideInput): StateOverride | null {
  return null;
}

const OVERRIDE_BUILDERS: Record<string, (input: BuildOverrideInput) => StateOverride | null> = {
  V2: buildV2Override,
  V3: buildV3Override,
  V4: buildV4Override,
  BALANCER: buildBalancerOverride,
  CURVE: buildCurveOverride,
  DODO: buildDodoOverride,
  WOOFI: buildWoofiOverride,
};

export function buildStateOverride(input: BuildOverrideInput): StateOverride | null {
  const proto = protocolClass(input.protocol);
  const builder = OVERRIDE_BUILDERS[proto];
  if (!builder) return null;
  return builder(input);
}

export { protocolClass };
