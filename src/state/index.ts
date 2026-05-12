
/**
 * src/state/index.js — State fetching barrel export
 */

// V3 state
export {
  fetchPoolCore,
  fetchTickBitmap,
  fetchTickData,
  fetchV3PoolState,
  fetchMultipleV3States,
} from "./uniswap_v3.ts";

// V2 state
export {
  fetchV2PoolState,
  fetchMultipleV2States,
} from "./uniswap_v2.ts";

// DODO V2 state
export {
  fetchDodoPoolState,
  fetchMultipleDodoStates,
} from "./dodo.ts";

// WOOFi state
export {
  fetchWoofiPoolState,
  fetchMultipleWoofiStates,
} from "./woofi.ts";

// Watcher and Normalizer
export { StateWatcher } from "./watcher.ts";
export { normalizePoolState, validatePoolState } from "./normalizer.ts";
export { mergeStateIntoCache, reloadCacheFromRegistry } from "./cache_utils.ts";
