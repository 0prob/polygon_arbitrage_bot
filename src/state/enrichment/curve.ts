
/**
 * src/enrichment/curve.js — Curve on-chain enrichment
 *
 * Fetches pool tokens via the registry's get_coins() view call.
 * Uses readContractWithRetry() for automatic backoff on 429 errors.
 */

import { errorMessage } from "../../utils/errors.ts";
import {
  isNoDataReadContractError,
  readContractWithRetry,
  type ReadContractWithRetryParams,
} from "./rpc.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

const GET_COINS_ABI = [
  {
    name: "get_coins",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_pool", type: "address" }],
    outputs: [{ name: "", type: "address[8]" }],
  },
];

function normalizeCurveTokenList(values: unknown) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== ZERO)
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value));
}

type CurveReadContract = <T = unknown>(params: ReadContractWithRetryParams) => Promise<T>;


/**
 * Fetch token addresses for a Curve pool via the registry.
 * Retries automatically on HTTP 429 / 5xx with exponential backoff.
 *
 * @param {string} poolAddress     Pool contract address
 * @param {string} registryAddress Curve registry that tracks this pool
 * @returns {Promise<string[]>}
 */
export async function getCurveTokens(
  poolAddress: unknown,
  registryAddress: unknown,
  readContractImpl: CurveReadContract = readContractWithRetry,
) {
  try {
    const tokens = await readContractImpl<unknown[]>({
      address: registryAddress,
      abi: GET_COINS_ABI,
      functionName: "get_coins",
      args: [poolAddress],
    });
    return normalizeCurveTokenList(tokens);
  } catch (error: unknown) {
    if (isNoDataReadContractError(error)) {
      console.error(
        `  Curve registry returned no token data for ${poolAddress}: ${errorMessage(error)}`
      );
      return [];
    }
    console.error(
      `  Error fetching Curve tokens for ${poolAddress}: ${errorMessage(error)}`
    );
    throw error;
  }
}
