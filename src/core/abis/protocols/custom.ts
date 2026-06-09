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
] as const;

export const POOL_MANAGER_LOCK_ABI = [
  {
    name: "lock",
    type: "function",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [{ name: "result", type: "bytes" }],
    stateMutability: "payable",
  },
] as const;

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
] as const;

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
] as const;

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
] as const;

export const DODO_SELL_BASE_ABI = [
  {
    name: "sellBase",
    type: "function",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ name: "receiveQuoteAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

export const DODO_SELL_QUOTE_ABI = [
  {
    name: "sellQuote",
    type: "function",
    inputs: [{ name: "to", type: "address" }],
    outputs: [{ name: "receiveBaseAmount", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;
