export type RouteState = Record<string, unknown>;
export type RouteStateCache = Map<string, RouteState>;

export type SimulatedHopResult = {
  amountOut: bigint;
  gasEstimate: number;
};

export type SimulationEdge = {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  protocol: string;
  zeroForOne: boolean;
  fee?: number | bigint | string | null;
  swapFeeBps?: number | null;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  stateRef?: RouteState | null;
  swapFn?: ((
    state: RouteState,
    amountIn: bigint,
    zeroForOne: boolean,
    fee?: number,
  ) => SimulatedHopResult) | null;
};

export type SimulationPath = {
  startToken: string;
  hopCount: number;
  logWeight: unknown;
  cumulativeFeesBps?: number;
  edges: SimulationEdge[];
};

export type RouteSimulationResult = {
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
  profitable: boolean;
  hopAmounts: bigint[];
  totalGas: number;
  poolPath: string[];
  tokenPath: string[];
  protocols: string[];
  hopCount: number;
};

export type RouteResultCore = Pick<
  RouteSimulationResult,
  "amountIn" | "amountOut" | "profit" | "totalGas"
>;

export type RouteResultTrace = Pick<
  RouteSimulationResult,
  "profitable" | "hopCount" | "poolPath" | "tokenPath" | "hopAmounts" | "protocols"
>;

export type RouteOptimizationOptions = {
  minAmount?: bigint;
  maxAmount?: bigint;
  iterations?: number;
  scorer?: (result: RouteSimulationResult) => bigint;
  accept?: (result: RouteSimulationResult) => boolean;
};

export type EvaluatePathsOptions = {
  optimize?: boolean;
  workerCount?: number;
  [key: string]: unknown;
};

export type EvaluatedRoute<TPath extends SimulationPath = SimulationPath> = {
  path: TPath;
  result: RouteSimulationResult;
};
