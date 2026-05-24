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

export const DODO_SELL_BASE_ABI = [
  {
    name: "sellBase",
    type: "function",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ name: "receiveQuoteAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

export const DODO_SELL_QUOTE_ABI = [
  {
    name: "sellQuote",
    type: "function",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ name: "receiveBaseAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

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

export const CURVE_EXCHANGE_INT128_ABI = [
  {
    name: "exchange",
    type: "function",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

export const CURVE_EXCHANGE_UINT256_ABI = [
  {
    name: "exchange",
    type: "function",
    inputs: [
      { name: "i", type: "uint256" },
      { name: "j", type: "uint256" },
      { name: "dx", type: "uint256" },
      { name: "min_dy", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

export const CURVE_EXCHANGE_INT128_RECEIVER_ABI = [
  {
    name: "exchange",
    type: "function",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
      { name: "min_dy", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
];

export const BALANCER_VAULT_SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    inputs: [
      {
        name: "singleSwap",
        type: "tuple",
        components: [
          { name: "poolId", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "assetIn", type: "address" },
          { name: "assetOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "userData", type: "bytes" },
        ],
      },
      {
        name: "funds",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "fromInternalBalance", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "toInternalBalance", type: "bool" },
        ],
      },
      { name: "limit", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountCalculated", type: "uint256" }],
    stateMutability: "payable",
  },
];

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

export const POOL_MANAGER_LOCK_ABI = [
  {
    name: "lock",
    type: "function",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "result", type: "bytes" }],
    stateMutability: "payable",
  },
];

export const CALL_STRUCT_ARRAY_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;
