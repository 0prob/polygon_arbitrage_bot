/**
 * src/protocols/index.js — Protocol registry
 *
 * Aggregates all protocol definitions into a single PROTOCOLS map.
 * Each protocol defines: name, address, signature, decode(), and
 * optionally enrichTokens().
 *
 * V2 PairCreated protocols are defined inline as a data array
 * (collapsed from 10 individual stub files).
 */

import QUICKSWAP_V3 from "./quickswap_v3.ts";
import KYBERSWAP_ELASTIC from "./kyberswap_elastic.ts";
import BALANCER_V2 from "./balancer_v2.ts";
import CURVE_MAIN_REGISTRY from "./curve_main_registry.ts";
import CURVE_STABLE_FACTORY from "./curve_stable_factory.ts";
import CURVE_CRYPTO_FACTORY from "./curve_crypto_factory.ts";
import CURVE_STABLESWAP_NG from "./curve_stableswap_ng.ts";
import CURVE_TRICRYPTO_NG from "./curve_tricrypto_ng.ts";
import { DODO_DVM, DODO_DPP, DODO_DSP } from "./dodo_v2.ts";
import WOOFI from "./woofi.ts";
import { createPairCreatedProtocol, createUniV3PoolProtocol } from "./factories.ts";

// ─── Inline V2 pair-created protocols ─────────────────────────

const V2_PROTOCOL_DEFS: Array<[string, string, string, number?]> = [
  ["QuickSwap V2", "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", "QUICKSWAP_V2", 13950000],
  ["SushiSwap V2", "0xc35dadb65012ec5796536bd9864ed8773abc74c4", "SUSHISWAP_V2", 15700000],
  ["Dfyn V2", "0xE7Fb3e833eFE5F9c441105EB65Ef8b261266423B", "DFYN_V2", 13000000],
  ["ApeSwap V2", "0xCf083Be4164828f00cAE704EC15a36D711491284", "APESWAP_V2", 15000000],
  ["Uniswap V2", "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C", "UNISWAP_V2", 14026000],
];

// ─── Inline V3 pool-created protocols ─────────────────────────

const V3_PROTOCOL_DEFS: Array<[string, string, string, number?]> = [
  ["Uniswap V3", "0x1F98431c8aD98523631AE4a59f267346ea31F984", "UNISWAP_V3", 26000000],
  ["SushiSwap V3", "0x917933899c6a5F8E37F31E19f92CdBFF7e8FF0e2", "SUSHISWAP_V3", 26000000],
];

/** Build PROTOCOLS map from inline definitions plus standalone modules. */
function buildProtocols() {
  const result: Record<string, unknown> = {};

  for (const [name, address, key, startBlock] of V2_PROTOCOL_DEFS) {
    result[key] = createPairCreatedProtocol(name, address, {}, { startBlock: startBlock ?? 0 });
  }

  for (const [name, address, key, startBlock] of V3_PROTOCOL_DEFS) {
    result[key] = createUniV3PoolProtocol(name, address, {}, undefined, { startBlock: startBlock ?? 0 });
  }

  // Standalone protocol modules
  result["QUICKSWAP_V3"] = QUICKSWAP_V3;
  result["KYBERSWAP_ELASTIC"] = KYBERSWAP_ELASTIC;
  result["BALANCER_V2"] = BALANCER_V2;
  result["CURVE_MAIN_REGISTRY"] = CURVE_MAIN_REGISTRY;
  result["CURVE_STABLE_FACTORY"] = CURVE_STABLE_FACTORY;
  result["CURVE_CRYPTO_FACTORY"] = CURVE_CRYPTO_FACTORY;
  result["CURVE_STABLESWAP_NG"] = CURVE_STABLESWAP_NG;
  result["CURVE_TRICRYPTO_NG"] = CURVE_TRICRYPTO_NG;
  result["DODO_DVM"] = DODO_DVM;
  result["DODO_DPP"] = DODO_DPP;
  result["DODO_DSP"] = DODO_DSP;
  result["WOOFI"] = WOOFI;

  return result;
}

export const PROTOCOLS = buildProtocols();

export { CONTRACT_CATALOG, POLYGON_CHAIN_ID } from "./contract_catalog.ts";
export * from "./classification.ts";

/**
 * Curve PoolRemoved lifecycle event definition.
 * Used to mark pools as removed in the registry.
 */
export const CURVE_POOL_REMOVED = {
  name: "Curve PoolRemoved",
  address: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5",
  startBlock: 15000000,
  signature: "event PoolRemoved(address indexed pool)",
};
