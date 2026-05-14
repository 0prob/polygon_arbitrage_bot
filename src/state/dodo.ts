import { isNoDataReadContractError, readContractWithRetry, throttledMap } from "../state/enrichment/rpc.ts";
import { ENRICH_CONCURRENCY } from "../config/index.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import { errorMessage } from "../utils/errors.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FEE_USER = normalizeEvmAddress(process.env.EXECUTOR_ADDRESS) ?? ZERO_ADDRESS;

const GET_PMM_STATE_ABI = [
  {
    name: "getPMMState",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "i", type: "uint256" },
          { name: "K", type: "uint256" },
          { name: "B", type: "uint256" },
          { name: "Q", type: "uint256" },
          { name: "B0", type: "uint256" },
          { name: "Q0", type: "uint256" },
          { name: "R", type: "uint8" },
        ],
      },
    ],
  },
];

const DODO_TOKEN_ABI = [
  {
    name: "_BASE_TOKEN_",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "_QUOTE_TOKEN_",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
];

const GET_USER_FEE_RATE_ABI = [
  {
    name: "getUserFeeRate",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "userAddr", type: "address" }],
    outputs: [
      { name: "lpFeeRate", type: "uint256" },
      { name: "mtFeeRate", type: "uint256" },
    ],
  },
];

const DODO_DIRECT_FEE_ABI = [
  {
    name: "_LP_FEE_RATE_",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "_MT_FEE_RATE_",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

type TupleLike = Record<string, unknown> & { [index: number]: unknown };
type BigIntish = bigint | boolean | number | string;

export type DodoFeeRates = {
  lpFeeRate: bigint;
  mtFeeRate: bigint;
  feeSource: "getUserFeeRate" | "direct";
};

export type DodoPoolState = {
  address: string;
  baseToken: string | null;
  quoteToken: string | null;
  i: bigint;
  k: bigint;
  baseReserve: bigint;
  quoteReserve: bigint;
  baseTarget: bigint;
  quoteTarget: bigint;
  rState: number;
  lpFeeRate: bigint;
  mtFeeRate: bigint;
  feeSource: DodoFeeRates["feeSource"];
  fetchedAt: number;
};

export type DodoStateMap = Map<string, DodoPoolState> & {
  noDataFailures?: Set<string>;
};

type DodoFetchResult = { addr: string; state: DodoPoolState; error: null } | { addr: string; state: null; error: unknown };

function tupleValue(state: unknown, index: number, key: string) {
  if (state == null || (typeof state !== "object" && typeof state !== "function")) return undefined;
  const tuple = state as TupleLike;
  return tuple[key] ?? tuple[index];
}

function toBigIntValue(value: unknown, fallback?: bigint) {
  if (value == null) {
    if (fallback !== undefined) return fallback;
    throw new Error("missing bigint value");
  }
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return BigInt(value as BigIntish);
  }
  throw new Error(`invalid bigint value: ${String(value)}`);
}

function normalizeFeeResult(result: unknown): Omit<DodoFeeRates, "feeSource"> {
  return {
    lpFeeRate: toBigIntValue(tupleValue(result, 0, "lpFeeRate"), 0n),
    mtFeeRate: toBigIntValue(tupleValue(result, 1, "mtFeeRate"), 0n),
  };
}

async function fetchDodoFeeRates(poolAddress: string): Promise<DodoFeeRates> {
  try {
    const result = await readContractWithRetry({
      address: poolAddress,
      abi: GET_USER_FEE_RATE_ABI,
      functionName: "getUserFeeRate",
      args: [FEE_USER],
    });
    return {
      ...normalizeFeeResult(result),
      feeSource: "getUserFeeRate",
    };
  } catch {
    const [lpResult, mtResult] = await Promise.allSettled([
      readContractWithRetry({
        address: poolAddress,
        abi: DODO_DIRECT_FEE_ABI,
        functionName: "_LP_FEE_RATE_",
      }),
      readContractWithRetry({
        address: poolAddress,
        abi: DODO_DIRECT_FEE_ABI,
        functionName: "_MT_FEE_RATE_",
      }),
    ]);
    return {
      lpFeeRate: lpResult.status === "fulfilled" ? toBigIntValue(lpResult.value, 0n) : 0n,
      mtFeeRate: mtResult.status === "fulfilled" ? toBigIntValue(mtResult.value, 0n) : 0n,
      feeSource: "direct",
    };
  }
}

export async function fetchDodoPoolState(poolAddress: string): Promise<DodoPoolState> {
  const [pmmState, baseToken, quoteToken, fees] = await Promise.all([
    readContractWithRetry({
      address: poolAddress,
      abi: GET_PMM_STATE_ABI,
      functionName: "getPMMState",
    }),
    readContractWithRetry({
      address: poolAddress,
      abi: DODO_TOKEN_ABI,
      functionName: "_BASE_TOKEN_",
    }),
    readContractWithRetry({
      address: poolAddress,
      abi: DODO_TOKEN_ABI,
      functionName: "_QUOTE_TOKEN_",
    }),
    fetchDodoFeeRates(poolAddress),
  ]);

  return {
    address: poolAddress,
    baseToken: normalizeEvmAddress(baseToken),
    quoteToken: normalizeEvmAddress(quoteToken),
    i: toBigIntValue(tupleValue(pmmState, 0, "i")),
    k: toBigIntValue(tupleValue(pmmState, 1, "K")),
    baseReserve: toBigIntValue(tupleValue(pmmState, 2, "B")),
    quoteReserve: toBigIntValue(tupleValue(pmmState, 3, "Q")),
    baseTarget: toBigIntValue(tupleValue(pmmState, 4, "B0")),
    quoteTarget: toBigIntValue(tupleValue(pmmState, 5, "Q0")),
    rState: Number(tupleValue(pmmState, 6, "R")),
    lpFeeRate: fees.lpFeeRate,
    mtFeeRate: fees.mtFeeRate,
    feeSource: fees.feeSource,
    fetchedAt: Date.now(),
  };
}

export async function fetchMultipleDodoStates(poolAddresses: string[], concurrency = ENRICH_CONCURRENCY): Promise<DodoStateMap> {
  const states: DodoStateMap = new Map();
  const noDataFailures = new Set<string>();

  const results = await throttledMap(
    poolAddresses,
    async (addr): Promise<DodoFetchResult> => {
      try {
        const state = await fetchDodoPoolState(addr);
        return { addr, state, error: null };
      } catch (error) {
        if (isNoDataReadContractError(error)) {
          noDataFailures.add(String(addr).toLowerCase());
        }
        console.warn(`  Failed to fetch DODO state for ${addr}: ${errorMessage(error)}`);
        return { addr, state: null, error };
      }
    },
    concurrency,
  );

  for (const { addr, state } of results) {
    if (state) {
      states.set(String(addr).toLowerCase(), state);
    }
  }

  states.noDataFailures = noDataFailures;
  return states;
}
