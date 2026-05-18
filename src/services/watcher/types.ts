import type { Address } from "../../core/types/common.ts";

export type MutableWatcherState = Record<string, unknown>;

export type RouteStateCache = Map<string, MutableWatcherState>;

export interface WatcherPoolMeta {
  address: Address;
  protocol: string;
  token0: Address;
  token1: Address;
  fee?: bigint;
  tickSpacing?: number;
  metadata?: Record<string, unknown>;
}

export type WatcherEnqueueEnrichment = (addr: string, task: () => unknown) => undefined;

export type WatcherPoolRefresh = (addr: string, pool: WatcherPoolMeta | null) => unknown;

export type WatcherV3Refresh = (addr: string, pool: WatcherPoolMeta | null, rawLog?: HyperSyncLogLike) => unknown;

export interface WatcherPersistedStateUpdate {
  pool_address: string;
  block: number;
  data: MutableWatcherState;
}

export interface WatcherStateUpdate {
  addr: string;
  state: MutableWatcherState;
  rawLog: HyperSyncLogLike;
}

export interface V3WatcherTickState {
  liquidityGross: bigint;
  liquidityNet: bigint;
}

export interface HyperSyncLogLike {
  address?: string;
  blockNumber?: number;
  topics?: string[];
  data?: string;
  transactionHash?: string;
  logIndex?: number;
  transactionIndex?: number;
}

export interface DecodedWatcherLog {
  indexed: Array<{ val?: unknown }>;
  body: Array<{ val?: unknown }>;
}
