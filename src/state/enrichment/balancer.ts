/**
 * src/enrichment/balancer.js — Balancer V2 on-chain enrichment
 *
 * Fetches pool tokens via the Vault's getPoolTokens() view call.
 * Uses readContractWithRetry() for automatic backoff on 429 errors.
 */

import { errorMessage } from "../../utils/errors.ts";
import { isNoDataReadContractError, readContractWithRetry, type ReadContractWithRetryParams } from "./rpc.ts";

const VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

const GET_POOL_TOKENS_ABI = [
  {
    name: "getPoolTokens",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "tokens", type: "address[]" },
      { name: "balances", type: "uint256[]" },
      { name: "lastChangeBlock", type: "uint256" },
    ],
  },
];

function normalizeAddressList(values: unknown) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value));
}

type BalancerReadContract = <T = unknown>(params: ReadContractWithRetryParams) => Promise<T>;
type BalancerPoolTokensResult = readonly [unknown, ...unknown[]];

/**
 * Fetch token addresses for a Balancer pool by its poolId.
 * Retries automatically on HTTP 429 / 5xx with exponential backoff.
 *
 * @param {string} poolId  The 32-byte Balancer pool ID
 * @returns {Promise<string[]>}
 */
export async function getBalancerTokens(poolId: unknown, readContractImpl: BalancerReadContract = readContractWithRetry) {
  try {
    const [tokens] = await readContractImpl<BalancerPoolTokensResult>({
      address: VAULT_ADDRESS,
      abi: GET_POOL_TOKENS_ABI,
      functionName: "getPoolTokens",
      args: [poolId],
    });
    return normalizeAddressList(tokens);
  } catch (error: unknown) {
    if (isNoDataReadContractError(error)) {
      console.error(`  Balancer vault returned no token data for poolId ${poolId}: ${errorMessage(error)}`);
      return [];
    }
    console.error(`  Error fetching Balancer tokens for poolId ${poolId}: ${errorMessage(error)}`);
    throw error;
  }
}
