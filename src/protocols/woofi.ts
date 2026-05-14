import { fetchBlockRollbackGuard, readContractWithRetry, throttledMap } from "../state/enrichment/rpc.ts";
import { normalizeEvmAddress } from "../utils/pool_record.ts";
import type { ProtocolDefinition, ProtocolDiscoveryContext } from "./factories.ts";
import {
  WOOFI_PROTOCOL,
  WOOFI_WOOPP_V2,
  WOOFI_WOORACLE_V2,
  WOOFI_ROUTER_V2,
  WOOFI_INTEGRATION_HELPER,
  WOOFI_POOL_ABI,
  WOOFI_ORACLE_ABI,
  tupleValue,
  bigintOrZero,
  isRecord,
} from "./woofi_shared.ts";

export { WOOFI_PROTOCOL, WOOFI_WOOPP_V2, WOOFI_WOORACLE_V2, WOOFI_ROUTER_V2, WOOFI_INTEGRATION_HELPER };

const DEFAULT_POLYGON_TOKEN_CANDIDATES = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // native USDC
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", // WBTC
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", // DAI
  "0x1B815d120B3eF02039Ee11dC2d33DE7aA4a8C603", // WOO
];

function parseConfiguredTokens() {
  const configured = process.env.WOOFI_TOKENS || process.env.WOOFI_POLYGON_TOKENS || "";
  return configured
    .split(",")
    .map((token) => normalizeEvmAddress(token))
    .filter((token): token is string => token != null);
}

function uniqueAddresses(values: unknown[]) {
  return [...new Set(values.map((value) => normalizeEvmAddress(value)).filter((value): value is string => value != null))];
}

type WoofiDiscoveryRegistry = {
  setCheckpoint: (key: string, block: number) => unknown;
  upsertPool: (pool: Record<string, unknown>) => unknown;
  getAllTokenAddresses?: () => string[];
};

function requireWoofiRegistry(registry: unknown): WoofiDiscoveryRegistry {
  if (isRecord(registry) && typeof registry.setCheckpoint === "function" && typeof registry.upsertPool === "function") {
    return registry as WoofiDiscoveryRegistry;
  }
  throw new Error("WOOFi discovery requires registry setCheckpoint() and upsertPool() methods");
}

function registryTokenCandidates(registry: WoofiDiscoveryRegistry): string[] {
  try {
    if (typeof registry.getAllTokenAddresses === "function") {
      const addresses = registry.getAllTokenAddresses();
      if (Array.isArray(addresses)) return addresses;
    }
  } catch {}
  return [];
}

async function readWoofiAddress(poolAddress: string, functionName: "quoteToken" | "wooracle") {
  return normalizeEvmAddress(
    await readContractWithRetry({
      address: poolAddress,
      abi: WOOFI_POOL_ABI,
      functionName,
    }),
  );
}

async function hasLiveWoofiBase(poolAddress: string, wooracle: string, token: string) {
  const tokenInfo = await readContractWithRetry({
    address: poolAddress,
    abi: WOOFI_POOL_ABI,
    functionName: "tokenInfos",
    args: [token],
  }).catch(() => null);
  if (tokenInfo == null) return false;
  const oracleState = await readContractWithRetry({
    address: wooracle,
    abi: WOOFI_ORACLE_ABI,
    functionName: "state",
    args: [token],
  }).catch(() => null);
  if (oracleState == null) return false;
  return (
    bigintOrZero(tupleValue(tokenInfo, 0, "reserve")) > 0n &&
    bigintOrZero(tupleValue(oracleState, 0, "price")) > 0n &&
    tupleValue(oracleState, 3, "woFeasible") !== false
  );
}

export async function discoverWoofiPool({ key, registry, chainHeight }: ProtocolDiscoveryContext) {
  const woofiRegistry = requireWoofiRegistry(registry);
  const poolAddress = normalizeEvmAddress(process.env.WOOFI_WOOPP_V2 || WOOFI_WOOPP_V2)!;
  const router = normalizeEvmAddress(process.env.WOOFI_ROUTER_V2 || WOOFI_ROUTER_V2)!;
  const rollbackGuard = await fetchBlockRollbackGuard();
  const quoteToken = await readWoofiAddress(poolAddress, "quoteToken");
  if (!quoteToken) {
    throw new Error("WOOFi discovery failed: WooPP quoteToken() returned an invalid address");
  }
  const wooracle = (await readWoofiAddress(poolAddress, "wooracle")) ?? normalizeEvmAddress(WOOFI_WOORACLE_V2)!;
  const candidates = uniqueAddresses([
    quoteToken,
    ...parseConfiguredTokens(),
    ...DEFAULT_POLYGON_TOKEN_CANDIDATES,
    ...registryTokenCandidates(woofiRegistry),
  ]).filter((token) => token !== quoteToken);

  const liveFlags = await throttledMap(candidates, (token) => hasLiveWoofiBase(poolAddress, wooracle, token), 4);
  const liveBaseTokens = candidates.filter((_token, index) => liveFlags[index]);
  const tokens = [quoteToken, ...liveBaseTokens];

  if (tokens.length < 2) {
    const checkpointBlock = Number.isSafeInteger(Number(chainHeight)) ? Number(chainHeight) : 0;
    woofiRegistry.setCheckpoint(key, checkpointBlock);
    console.warn(
      `  WOOFi discovery found no live base tokens (checked ${candidates.length} candidate(s)). ` +
        `Set WOOFI_TOKENS or WOOFI_POLYGON_TOKENS env var to seed additional candidates.`,
    );
    return { discovered: 0, checkpointBlock, rollbackGuard };
  }

  const checkpointBlock = Number.isSafeInteger(Number(chainHeight)) ? Number(chainHeight) : 0;
  woofiRegistry.upsertPool({
    protocol: key,
    pool_address: poolAddress,
    tokens,
    block: checkpointBlock,
    tx: null,
    metadata: {
      router,
      wooPP: poolAddress,
      wooracle,
      quoteToken,
      integrationHelper: normalizeEvmAddress(WOOFI_INTEGRATION_HELPER),
      discoveryMode: "singleton",
    },
    status: "active",
  });
  woofiRegistry.setCheckpoint(key, checkpointBlock);

  console.log(`  Inserted/updated WOOFi singleton pool with ${tokens.length} token(s).`);
  return { discovered: 1, checkpointBlock, rollbackGuard };
}

const WOOFI: ProtocolDefinition = {
  name: "WOOFi WooPPV2",
  address: WOOFI_WOOPP_V2,
  capabilities: {
    discovery: true,
    routing: true,
    execution: true,
  },
  discover: discoverWoofiPool,
};

export default WOOFI;
