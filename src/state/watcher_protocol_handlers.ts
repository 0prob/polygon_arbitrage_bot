
/**
 * src/state/watcher_protocol_handlers.js — Topic dispatcher for StateWatcher
 */

import type {
  DecodedWatcherLog,
  MutableWatcherState,
  WatcherPoolMeta,
  WatcherProtocolHandler,
  WatcherTopicMap,
} from "./watcher_types.ts";

type WatcherProtocolHandlerDeps = {
  topic0: WatcherTopicMap;
  updateV2State: (
    state: MutableWatcherState,
    decoded: DecodedWatcherLog,
    pool?: WatcherPoolMeta | null,
  ) => void;
  updateV3SwapState: (
    state: MutableWatcherState,
    decoded: DecodedWatcherLog,
    pool?: WatcherPoolMeta | null,
  ) => void;
  updateV3LiquidityState: (
    state: MutableWatcherState,
    decoded: DecodedWatcherLog,
    isMint: boolean,
    pool?: WatcherPoolMeta | null,
  ) => void;
};

export function createWatcherProtocolHandlers({
  topic0,
  updateV2State,
  updateV3SwapState,
  updateV3LiquidityState,
}: WatcherProtocolHandlerDeps): Map<string, WatcherProtocolHandler> {
  function hasInitializedV3BaseState(state: MutableWatcherState) {
    return (
      state?.initialized === true &&
      state?.sqrtPriceX96 != null &&
      state?.sqrtPriceX96 !== 0n &&
      Number.isInteger(state?.tick) &&
      state?.liquidity != null
    );
  }

  return new Map<string, WatcherProtocolHandler>([
    [topic0.V2_SYNC, ({ state, decoded, pool }) => {
      updateV2State(state, decoded, pool);
      return true;
    }],
    [topic0.V3_SWAP, ({ state, decoded, pool }) => {
      updateV3SwapState(state, decoded, pool);
      return true;
    }],
    [topic0.V3_MINT, ({ addr, log, state, decoded, pool, enqueueEnrichment, refreshV3 }) => {
      if (!hasInitializedV3BaseState(state)) {
        enqueueEnrichment(addr, () => refreshV3(addr, pool, log));
        return false;
      }
      updateV3LiquidityState(state, decoded, true, pool);
      return true;
    }],
    [topic0.V3_BURN, ({ addr, log, state, decoded, pool, enqueueEnrichment, refreshV3 }) => {
      if (!hasInitializedV3BaseState(state)) {
        enqueueEnrichment(addr, () => refreshV3(addr, pool, log));
        return false;
      }
      updateV3LiquidityState(state, decoded, false, pool);
      return true;
    }],
    [topic0.BAL_BALANCE, ({ addr, pool, enqueueEnrichment, refreshBalancer }) => {
      enqueueEnrichment(addr, () => refreshBalancer(addr, pool));
      // Balancer balance-change logs require a full Vault refresh; do not recommit
      // the pre-refresh cache snapshot, which may be partial or stale.
      return false;
    }],
    [topic0.CURVE_EXCHANGE_STABLE, ({ addr, pool, enqueueEnrichment, refreshCurve }) => {
      enqueueEnrichment(addr, () => refreshCurve(addr, pool));
      // Curve exchange logs do not contain full balances; the refresh task owns
      // committing the complete state after fetching balances/A/fees on-chain.
      return false;
    }],
    [topic0.CURVE_EXCHANGE_UNDERLYING, ({ addr, pool, enqueueEnrichment, refreshCurve }) => {
      enqueueEnrichment(addr, () => refreshCurve(addr, pool));
      // Curve ExchangeUnderlying logs likewise need a full pool refresh.
      return false;
    }],
    [topic0.CURVE_EXCHANGE_CRYPTO, ({ addr, pool, enqueueEnrichment, refreshCurve }) => {
      enqueueEnrichment(addr, () => refreshCurve(addr, pool));
      // Curve crypto logs likewise need a full state refresh before commit.
      return false;
    }],
    [topic0.DODO_SWAP, ({ addr, pool, enqueueEnrichment, refreshDodo }) => {
      enqueueEnrichment(addr, () => refreshDodo(addr, pool));
      // DODO swap logs are refreshed from full PMM state; do not recommit a stale cache snapshot.
      return false;
    }],
    [topic0.WOOFI_SWAP, ({ addr, pool, enqueueEnrichment, refreshWoofi }) => {
      enqueueEnrichment(addr, () => refreshWoofi(addr, pool));
      // WOOFi swap logs are refreshed from full pool/oracle state; do not
      // recommit a stale cache snapshot while the refresh is pending.
      return false;
    }],
  ]);
}
