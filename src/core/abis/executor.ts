export const ARB_EXECUTOR_ABI = [
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
  {
    name: "executeArbWithAave",
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
  {
    name: "transferAll",
    type: "function",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { name: "Unauthorized", type: "error", inputs: [] },
  { name: "DeadlineExpired", type: "error", inputs: [] },
  { name: "EmptyRoute", type: "error", inputs: [] },
  { name: "TooManyCalls", type: "error", inputs: [] },
  { name: "FlashLoanRequired", type: "error", inputs: [] },
  { name: "InvalidRouteHash", type: "error", inputs: [] },
  { name: "FlashLoanOnly", type: "error", inputs: [] },
  { name: "InvalidFlashLoanContext", type: "error", inputs: [] },
  { name: "CallbackOnly", type: "error", inputs: [] },
  { name: "InvalidCallbackSource", type: "error", inputs: [] },
  { name: "UnsupportedProtocol", type: "error", inputs: [{ name: "protocolId", type: "uint8" }] },
  {
    name: "InvalidPoolCaller",
    type: "error",
    inputs: [
      { name: "expected", type: "address" },
      { name: "actual", type: "address" },
    ],
  },
  {
    name: "ExternalCallFailed",
    type: "error",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "target", type: "address" },
      { name: "reason", type: "bytes" },
    ],
  },
  {
    name: "InsufficientProfit",
    type: "error",
    inputs: [
      { name: "finalBalance", type: "uint256" },
      { name: "requiredBalance", type: "uint256" },
    ],
  },
  {
    name: "TransferFailed",
    type: "error",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  {
    name: "ApproveFailed",
    type: "error",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
  },
  { name: "ZeroAddress", type: "error", inputs: [] },
] as const;

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
