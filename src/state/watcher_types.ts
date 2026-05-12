import type { HyperSyncRawLog } from "../hypersync/logs.ts";
import type { RouteState } from "../routing/simulation_types.ts";

export type DecodedWatcherLogValue = {
  val: unknown;
};

export type DecodedWatcherLog = {
  indexed?: DecodedWatcherLogValue[];
  body?: DecodedWatcherLogValue[];
};

export type WatcherPoolMeta = {
  pool_address?: unknown;
  protocol?: unknown;
  tokens?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

export type V3WatcherTickState = {
  liquidityGross: bigint;
  liquidityNet: bigint;
};

export type MutableWatcherState = RouteState & {
  reserve0?: bigint;
  reserve1?: bigint;
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
  tick?: number;
  ticks?: Map<number, V3WatcherTickState>;
  tickVersion?: number;
  initialized?: boolean;
  fee?: bigint;
  feeDenominator?: bigint;
  feeSource?: string;
};

export type WatcherTopicMap = {
  V2_SYNC: string;
  V3_SWAP: string;
  V3_MINT: string;
  V3_BURN: string;
  BAL_BALANCE: string;
  CURVE_EXCHANGE_STABLE: string;
  CURVE_EXCHANGE_CRYPTO: string;
  CURVE_EXCHANGE_UNDERLYING: string;
  DODO_SWAP: string;
  WOOFI_SWAP: string;
};

export type WatcherEnrichmentTask = () => unknown | Promise<unknown>;

export type WatcherEnqueueEnrichment = (
  addr: string,
  task: WatcherEnrichmentTask,
) => unknown | Promise<unknown>;

export type WatcherPoolRefresh = (
  addr: string,
  pool: WatcherPoolMeta | null,
) => unknown | Promise<unknown>;

export type WatcherV3Refresh = (
  addr: string,
  pool: WatcherPoolMeta | null,
  rawLog?: HyperSyncRawLog,
) => unknown | Promise<unknown>;

export type WatcherProtocolHandlerContext = {
  addr: string;
  log: HyperSyncRawLog;
  pool: WatcherPoolMeta | null;
  state: MutableWatcherState;
  decoded: DecodedWatcherLog;
  enqueueEnrichment: WatcherEnqueueEnrichment;
  refreshBalancer: WatcherPoolRefresh;
  refreshCurve: WatcherPoolRefresh;
  refreshDodo: WatcherPoolRefresh;
  refreshWoofi: WatcherPoolRefresh;
  refreshV3: WatcherV3Refresh;
};

export type WatcherProtocolHandler = (
  context: WatcherProtocolHandlerContext,
) => boolean;

export type WatcherStateUpdate = {
  addr: string;
  state: MutableWatcherState;
  rawLog: HyperSyncRawLog;
};

export type WatcherPersistedStateUpdate = {
  pool_address: string;
  block: number;
  data: MutableWatcherState;
};
