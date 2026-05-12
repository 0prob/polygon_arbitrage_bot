
/**
 * src/execution/abi_fragments.js — Minimal ABI fragments for calldata encoding
 *
 * Only includes the function signatures needed for building Call[] entries.
 * Using viem's human-readable ABI format for clarity.
 */

// ─── ERC-20 ───────────────────────────────────────────────────

/** ERC-20 transfer — used to send tokens to V2 pairs before swap */
export const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
];

/** ERC-20 approve — retained for setup/admin flows */
export const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
];

// ─── Uniswap V2 Pair ─────────────────────────────────────────

/** V2 pair.swap — direct pair swap (tokens must be in pair already) */
export const V2_PAIR_SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    inputs: [
      { name: "amount0Out", type: "uint256" },
      { name: "amount1Out", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

// ─── Uniswap V3 Pool ─────────────────────────────────────────

/**
 * V3 pool.swap — direct pool swap
 *
 * @param recipient The address to receive the output tokens
 * @param zeroForOne The direction of the swap, true for token0 to token1, false for token1 to token0
 * @param amountSpecified The amount of the swap, which implicitly configures the swap as exact input (positive), or exact output (negative)
 * @param sqrtPriceLimitX96 The Q64.96 sqrt price limit. If zero for one, the price cannot be less than this value after the swap. If one for zero, the price cannot be greater than this value after the swap
 * @param data Any data to be passed through to the callback
 */
export const V3_POOL_SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "zeroForOne", type: "bool" },
      { name: "amountSpecified", type: "int256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      { name: "amount0", type: "int256" },
      { name: "amount1", type: "int256" },
    ],
    stateMutability: "nonpayable",
  },
];

/**
 * KyberSwap Elastic pool.swap.
 *
 * Kyber uses `swapQty` and `isToken0` rather than the Uniswap V3
 * `zeroForOne` argument order, but still pays through `swapCallback`.
 */
export const KYBER_ELASTIC_POOL_SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "swapQty", type: "int256" },
      { name: "isToken0", type: "bool" },
      { name: "limitSqrtP", type: "uint160" },
      { name: "data", type: "bytes" },
    ],
    outputs: [
      { name: "qty0", type: "int256" },
      { name: "qty1", type: "int256" },
    ],
    stateMutability: "nonpayable",
  },
];

// ─── DODO V2 Pools ───────────────────────────────────────────

/** DODO V2 sellBase — tokens must be transferred into the pool first */
export const DODO_SELL_BASE_ABI = [
  {
    name: "sellBase",
    type: "function",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ name: "receiveQuoteAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

/** DODO V2 sellQuote — tokens must be transferred into the pool first */
export const DODO_SELL_QUOTE_ABI = [
  {
    name: "sellQuote",
    type: "function",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ name: "receiveBaseAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

// ─── WOOFi WooRouterV2 ───────────────────────────────────────

/** WOOFi router exact-input swap. Router pulls tokenIn from the executor. */
export const WOOFI_ROUTER_SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    inputs: [
      { name: "fromToken", type: "address" },
      { name: "toToken", type: "address" },
      { name: "fromAmount", type: "uint256" },
      { name: "minToAmount", type: "uint256" },
      { name: "to", type: "address" },
      { name: "rebateTo", type: "address" },
    ],
    outputs: [{ name: "realToAmount", type: "uint256" }],
    stateMutability: "payable",
  },
];

// ─── Uniswap V3 SwapRouter02 ─────────────────────────────────

/**
 * SwapRouter02.exactInputSingle
 *
 * struct ExactInputSingleParams {
 *   address tokenIn;
 *   address tokenOut;
 *   uint24 fee;
 *   address recipient;
 *   uint256 amountIn;
 *   uint256 amountOutMinimum;
 *   uint160 sqrtPriceLimitX96;
 * }
 */
export const V3_EXACT_INPUT_SINGLE_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
];

// ─── ArbExecutor ──────────────────────────────────────────────

/** ArbExecutor.executeArb — the top-level entry point */
export const EXECUTOR_ABI = [
  {
    name: "executeArb",
    type: "function",
    inputs: [
      { name: "flashToken", type: "address" },
      { name: "flashAmount", type: "uint256" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "profitToken", type: "address" },
          { name: "minProfit", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "routeHash", type: "bytes32" },
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "data", type: "bytes" },
            ],
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

/** ArbExecutor.preApprove — for setting up token approvals */
export const EXECUTOR_PRE_APPROVE_ABI = [
  {
    name: "preApprove",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

/** ArbExecutor.approveIfNeeded — dynamic approval during execution */
export const EXECUTOR_APPROVE_IF_NEEDED_ABI = [
  {
    name: "approveIfNeeded",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

// ─── Curve Pools ──────────────────────────────────────────────

/**
 * Curve stable pool exchange — int128 coin indices.
 * Used by: main registry pools, factory stable pools (e.g. 3pool, FRAX).
 *
 * @param i      Index of input coin
 * @param j      Index of output coin
 * @param dx     Amount of input coin to swap
 * @param min_dy Minimum acceptable output (slippage guard)
 */
export const CURVE_EXCHANGE_INT128_ABI = [
  {
    name: "exchange",
    type: "function",
    inputs: [
      { name: "i",      type: "int128"  },
      { name: "j",      type: "int128"  },
      { name: "dx",     type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

/**
 * Curve crypto pool exchange — uint256 coin indices.
 * Used by: tricrypto, factory crypto pools (e.g. USDC/ETH/BTC).
 *
 * @param i      Index of input coin
 * @param j      Index of output coin
 * @param dx     Amount of input coin to swap
 * @param min_dy Minimum acceptable output
 */
export const CURVE_EXCHANGE_UINT256_ABI = [
  {
    name: "exchange",
    type: "function",
    inputs: [
      { name: "i",      type: "uint256" },
      { name: "j",      type: "uint256" },
      { name: "dx",     type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

// ─── Balancer V2 Vault ────────────────────────────────────────

/**
 * Balancer Vault.swap — single-pool exactInput swap.
 *
 * The Vault pulls tokenIn from `funds.sender` and sends tokenOut
 * to `funds.recipient`. The executor therefore needs allowance-based
 * approval for the Vault before the swap call executes.
 *
 * SingleSwap:
 *   poolId         bytes32   Balancer pool ID
 *   kind           uint8     0 = GIVEN_IN, 1 = GIVEN_OUT
 *   assetIn        address
 *   assetOut       address
 *   amount         uint256   input amount (for GIVEN_IN)
 *   userData       bytes     pool-specific extra data (usually "0x")
 *
 * FundManagement:
 *   sender              address  token source (ArbExecutor)
 *   fromInternalBalance bool     false — use ERC-20 balance
 *   recipient           address  output destination (ArbExecutor)
 *   toInternalBalance   bool     false — deliver to ERC-20
 */
export const BALANCER_VAULT_SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    inputs: [
      {
        name: "singleSwap",
        type: "tuple",
        components: [
          { name: "poolId",   type: "bytes32" },
          { name: "kind",     type: "uint8"   },
          { name: "assetIn",  type: "address" },
          { name: "assetOut", type: "address" },
          { name: "amount",   type: "uint256" },
          { name: "userData", type: "bytes"   },
        ],
      },
      {
        name: "funds",
        type: "tuple",
        components: [
          { name: "sender",              type: "address" },
          { name: "fromInternalBalance", type: "bool"    },
          { name: "recipient",           type: "address" },
          { name: "toInternalBalance",   type: "bool"    },
        ],
      },
      { name: "limit",    type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountCalculated", type: "uint256" }],
    stateMutability: "payable",
  },
];
