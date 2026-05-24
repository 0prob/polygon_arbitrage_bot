export type ExecutorCall = {
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
};

export type CalldataHop = {
  protocol?: unknown;
  poolAddress?: unknown;
  tokenIn?: unknown;
  tokenOut?: unknown;
  zeroForOne?: unknown;
  amountIn?: unknown;
  amountOut?: unknown;
  fee?: unknown;
  swapFeeBps?: unknown;
  kyberSwapFeeBps?: unknown;
  router?: unknown;
  metadata?: Record<string, unknown>;
  tokenInIdx?: unknown;
  tokenOutIdx?: unknown;
  isCrypto?: unknown;
  poolId?: unknown;
  stateRef?: Record<string, unknown>;
};

export type CalldataRoute = {
  path: {
    edges: CalldataHop[];
  };
  result: {
    hopAmounts: unknown[];
  };
};

export type RouteCalldataOptions = {
  slippageBps?: number;
  deadline?: bigint;
};

export type FlashParamsInput = {
  profitToken: string;
  minProfit: bigint;
  deadline: bigint;
  calls: unknown;
};

export type ExecuteArbInput = FlashParamsInput & {
  executorAddress: string;
  flashToken: string;
  flashAmount: bigint;
};
