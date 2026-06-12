import type { FoundCycle } from "../pipeline/index.ts";
import type { PassLoopState } from "./pass_state.ts";

/** Immutable read view for a single HF tick — avoids torn reads from background LF work. */
export interface HfReadSnapshot {
  generation: number;
  cachedCycles: FoundCycle[];
  tokenToMaticRates: Map<string, bigint>;
  cachedMetas: Map<string, { decimals: number }> | null;
  maticPriceUsd: number;
  lfEnumerationInFlight: boolean;
  lastEnumerationTime: number;
}

export function publishHfSnapshot(state: PassLoopState): void {
  state.cyclesGeneration += 1;
  state.hfSnapshot = {
    generation: state.cyclesGeneration,
    cachedCycles: state.cachedCycles,
    tokenToMaticRates: new Map(state.tokenToMaticRates),
    cachedMetas: state.cachedMetas,
    maticPriceUsd: state.maticPriceUsd,
    lfEnumerationInFlight: state.lfEnumerationInFlight,
    lastEnumerationTime: state.lastEnumerationTime,
  };
}

export function getHfSnapshot(state: PassLoopState): HfReadSnapshot {
  return (
    state.hfSnapshot ?? {
      generation: 0,
      cachedCycles: state.cachedCycles,
      tokenToMaticRates: new Map(state.tokenToMaticRates),
      cachedMetas: state.cachedMetas,
      maticPriceUsd: state.maticPriceUsd,
      lfEnumerationInFlight: state.lfEnumerationInFlight,
      lastEnumerationTime: state.lastEnumerationTime,
    }
  );
}
