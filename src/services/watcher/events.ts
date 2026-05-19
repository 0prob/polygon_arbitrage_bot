export const V2_SYNC_SIG = "event Sync(uint112 reserve0, uint112 reserve1)";
export const V3_SWAP_SIG =
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
export const V3_MINT_SIG =
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
export const V3_BURN_SIG =
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)";
export const BAL_BALANCE_SIG =
  "event PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] deltas, uint256[] protocolFeeAmounts)";
export const CURVE_EXCHANGE_STABLE_SIG =
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
export const CURVE_EXCHANGE_CRYPTO_SIG =
  "event TokenExchange(address indexed buyer, uint256 sold_id, uint256 tokens_sold, uint256 bought_id, uint256 tokens_bought)";
export const CURVE_EXCHANGE_UNDERLYING_SIG =
  "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)";
export const DODO_SWAP_SIG =
  "event DODOSwap(address fromToken, address toToken, uint256 fromAmount, uint256 toAmount, address trader, address receiver)";
export const WOOFI_SWAP_SIG =
  "event WooSwap(address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address indexed to, address rebateTo, uint256 swapVol, uint256 swapFee)";

export const WATCHER_SIGNATURES = [
  V2_SYNC_SIG,
  V3_SWAP_SIG,
  V3_MINT_SIG,
  V3_BURN_SIG,
  BAL_BALANCE_SIG,
  CURVE_EXCHANGE_STABLE_SIG,
  CURVE_EXCHANGE_CRYPTO_SIG,
  CURVE_EXCHANGE_UNDERLYING_SIG,
  DODO_SWAP_SIG,
  WOOFI_SWAP_SIG,
] as const;
