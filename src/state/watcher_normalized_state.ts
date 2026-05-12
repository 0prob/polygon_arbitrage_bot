import type { RouteState } from "../routing/simulation_types.ts";
import type { MutableWatcherState } from "./watcher_types.ts";

function isWatcherTickState(value: unknown): value is NonNullable<MutableWatcherState["ticks"]> {
  if (!(value instanceof Map)) return false;
  for (const [tick, tickState] of value.entries()) {
    if (!Number.isInteger(tick)) return false;
    if (typeof tickState !== "object" || tickState == null) return false;
    const candidate = tickState as { liquidityGross?: unknown; liquidityNet?: unknown };
    if (typeof candidate.liquidityGross !== "bigint" || typeof candidate.liquidityNet !== "bigint") {
      return false;
    }
  }
  return true;
}

function assertWatcherStateField(condition: boolean, field: string, value: unknown): asserts condition {
  if (!condition) {
    throw new Error(`Invalid watcher normalized state field ${field}: ${typeof value}`);
  }
}

export function toMutableWatcherState(state: RouteState): MutableWatcherState {
  const next: MutableWatcherState = {};
  for (const [key, value] of Object.entries(state)) {
    switch (key) {
      case "reserve0":
      case "reserve1":
      case "sqrtPriceX96":
      case "liquidity":
      case "fee":
      case "feeDenominator":
        assertWatcherStateField(typeof value === "bigint", key, value);
        next[key] = value;
        break;
      case "tick":
      case "tickVersion":
        assertWatcherStateField(typeof value === "number" && Number.isFinite(value), key, value);
        next[key] = value;
        break;
      case "ticks":
        assertWatcherStateField(isWatcherTickState(value), key, value);
        next.ticks = value;
        break;
      case "initialized":
        assertWatcherStateField(typeof value === "boolean", key, value);
        next.initialized = value;
        break;
      case "feeSource":
        assertWatcherStateField(typeof value === "string", key, value);
        next.feeSource = value;
        break;
      default:
        next[key] = value;
        break;
    }
  }
  return next;
}
