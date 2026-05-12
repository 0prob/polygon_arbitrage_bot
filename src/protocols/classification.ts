import { normalizeProtocolKey } from "../utils/identity.ts";

export { normalizeProtocolKey } from "../utils/identity.ts";

export const V2_PROTOCOLS = new Set([
  "QUICKSWAP_V2",
  "SUSHISWAP_V2",
  "UNISWAP_V2",
  "DFYN_V2",
  "COMETHSWAP_V2",
  "APESWAP_V2",
  "MESHSWAP_V2",
  "JETSWAP_V2",
]);

export const ALL_V3_PROTOCOLS = new Set([
  "UNISWAP_V3",
  "QUICKSWAP_V3",
  "SUSHISWAP_V3",
  "KYBERSWAP_ELASTIC",
]);

let _v3EnabledInitialized = false;
let _v3Enabled = true;

function _v3Init() {
  if (_v3EnabledInitialized) return;
  _v3EnabledInitialized = true;
  try {
    const config = process.env.ENABLE_V3_PROTOCOLS;
    _v3Enabled = config === undefined || config === "" || config === "true" || config === "1";
  } catch {
    _v3Enabled = true;
  }
}

export function initV3Protocols(enabled: boolean): void {
  _v3EnabledInitialized = true;
  _v3Enabled = enabled;
}

export function V3_PROTOCOLS(): Set<string> {
  _v3Init();
  return _v3Enabled ? ALL_V3_PROTOCOLS : new Set();
}

export const CURVE_STABLE_PROTOCOLS = new Set([
  "CURVE_STABLE",
  "CURVE_MAIN",
  "CURVE_MAIN_REGISTRY",
  "CURVE_STABLE_FACTORY",
  "CURVE_STABLESWAP_NG",
]);

export const CURVE_CRYPTO_PROTOCOLS = new Set([
  "CURVE_CRYPTO",
  "CURVE_CRYPTO_FACTORY",
  "CURVE_TRICRYPTO_NG",
]);

export const CURVE_PROTOCOLS = new Set([
  ...CURVE_STABLE_PROTOCOLS,
  ...CURVE_CRYPTO_PROTOCOLS,
]);

export const BALANCER_PROTOCOLS = new Set([
  "BALANCER_WEIGHTED",
  "BALANCER_STABLE",
  "BALANCER_V2",
]);

export const DODO_PROTOCOLS = new Set([
  "DODO_DVM",
  "DODO_DPP",
  "DODO_DSP",
]);

export const WOOFI_PROTOCOLS = new Set([
  "WOOFI",
]);

export function SWAP_EXECUTION_PROTOCOLS(): Set<string> {
  return new Set([
    ...V2_PROTOCOLS,
    ...V3_PROTOCOLS(),
    ...CURVE_PROTOCOLS,
    ...BALANCER_PROTOCOLS,
    ...DODO_PROTOCOLS,
    ...WOOFI_PROTOCOLS,
  ]);
}

export function isV2Protocol(protocol: unknown) {
  return V2_PROTOCOLS.has(normalizeProtocolKey(protocol));
}

export function isV3Protocol(protocol: unknown) {
  return V3_PROTOCOLS().has(normalizeProtocolKey(protocol));
}

export function isCurveProtocol(protocol: unknown) {
  return CURVE_PROTOCOLS.has(normalizeProtocolKey(protocol));
}

export function isBalancerProtocol(protocol: unknown) {
  return BALANCER_PROTOCOLS.has(normalizeProtocolKey(protocol));
}

export function isDodoProtocol(protocol: unknown) {
  return DODO_PROTOCOLS.has(normalizeProtocolKey(protocol));
}

export function isWoofiProtocol(protocol: unknown) {
  return WOOFI_PROTOCOLS.has(normalizeProtocolKey(protocol));
}

export function isSwapExecutionProtocol(protocol: unknown) {
  return SWAP_EXECUTION_PROTOCOLS().has(normalizeProtocolKey(protocol));
}
