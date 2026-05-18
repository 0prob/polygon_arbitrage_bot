import { Decoder, client as hypersyncClient } from "../../infra/hypersync/client.ts";
import type { HypersyncDecoderRuntime } from "../../infra/hypersync/types.ts";
import { computeTopic0s } from "../../infra/hypersync/query.ts";
import type { CompatDatabase } from "../../infra/db/connection.ts";
import { createRootLogger } from "../../infra/observability/logger.ts";
import type { RouteStateCache, WatcherPoolMeta, WatcherEnqueueEnrichment } from "./types.ts";
import { WatcherFilter } from "./filter.ts";
import { pollLoop } from "./poll_loop.ts";

const logger = createRootLogger();

const V2_SYNC_SIG = "event Sync(uint112 reserve0, uint112 reserve1)";
const V3_SWAP_SIG = "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
const V3_MINT_SIG = "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
const V3_BURN_SIG = "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
const BAL_BALANCE_SIG = "event PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] deltas, uint256[] protocolFeeAmounts)";
const CURVE_EXCHANGE_STABLE_SIG = "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
const CURVE_EXCHANGE_CRYPTO_SIG = "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought)";
const CURVE_EXCHANGE_UNDERLYING_SIG = "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
const DODO_SWAP_SIG = "event DODOSwap(address fromToken, address toToken, uint256 fromAmount, uint256 toAmount, address trader, address receiver)";
const WOOFI_SWAP_SIG = "event WooSwap(address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo, uint256 swapVol, uint256 swapFee)";

export const WATCHER_SIGNATURES = [
  V2_SYNC_SIG, V3_SWAP_SIG, V3_MINT_SIG, V3_BURN_SIG,
  BAL_BALANCE_SIG, CURVE_EXCHANGE_STABLE_SIG, CURVE_EXCHANGE_CRYPTO_SIG, CURVE_EXCHANGE_UNDERLYING_SIG,
  DODO_SWAP_SIG, WOOFI_SWAP_SIG,
];

export class WatcherService {
  private _filter: WatcherFilter;
  private _stateCache: RouteStateCache;
  private _db: CompatDatabase;
  private _running = false;
  private _loopPromise: Promise<void> | null = null;
  private _decoder: HypersyncDecoderRuntime;
  private _registry: {
    getRollbackGuard?: () => unknown;
    setRollbackGuard?: (guard: Record<string, unknown>) => unknown;
    getPoolMeta?: (addr: string) => WatcherPoolMeta | null | undefined;
  };
  private _enrichmentQueue: Map<string, () => unknown> = new Map();

  onBatch: ((changed: Set<string>) => void) | null = null;
  onReorg: ((reorg: { reorgBlock: number; changedAddrs: Set<string> }) => void) | null = null;

  constructor(
    db: CompatDatabase,
    stateCache: RouteStateCache,
    registry: {
      getRollbackGuard?: () => unknown;
      setRollbackGuard?: (guard: Record<string, unknown>) => unknown;
      getPoolMeta?: (addr: string) => WatcherPoolMeta | null | undefined;
    } = {},
  ) {
    this._db = db;
    this._stateCache = stateCache;
    this._filter = new WatcherFilter();
    this._decoder = Decoder.fromSignatures(WATCHER_SIGNATURES);
    this._registry = registry;
  }

  start(pools?: string[]): void {
    if (this._running) return;
    this._running = true;
    if (pools && pools.length > 0) this._filter.add(pools);
    this._loopPromise = this._run();
    logger.info({}, "Watcher service started");
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._loopPromise) {
      await this._loopPromise.catch(() => {});
      this._loopPromise = null;
    }
    logger.info({}, "Watcher service stopped");
  }

  getStateCache(): RouteStateCache {
    return this._stateCache;
  }

  private enqueueEnrichment: WatcherEnqueueEnrichment = (addr, task) => {
    this._enrichmentQueue.set(addr.toLowerCase(), task);
    return undefined;
  };

  private noopRefresh = (_addr: string, _pool: WatcherPoolMeta | null) => {};

  private _run(): Promise<void> {
    return pollLoop(
      this._db,
      hypersyncClient,
      this._filter,
      this._stateCache,
      this._decoder,
      this._registry,
      this.enqueueEnrichment,
      this.noopRefresh,
      this.noopRefresh,
      this.noopRefresh,
      this.noopRefresh,
      this.noopRefresh,
      () => this._running,
      this.onBatch,
      this.onReorg,
    );
  }
}
