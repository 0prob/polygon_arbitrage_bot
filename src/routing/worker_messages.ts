import type {
  EvaluatePathsOptions,
  RouteSimulationResult,
  RouteState,
} from "./simulation_types.ts";

export type SerializedEvaluationEdge = {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  protocol: string;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  zeroForOne: boolean;
  fee?: number | bigint | string | null;
  swapFeeBps?: number | null;
};

export type SerializedEvaluationPath = {
  serialisedKey: string;
  startToken: string;
  hopCount: number;
  logWeight: unknown;
  cumulativeFeesBps?: number;
  edges: SerializedEvaluationEdge[];
};

export type SerializedEnumeratedPath = {
  startToken: string;
  hopCount: number;
  logWeight: unknown;
  cumulativeFeesBps?: number;
  poolAddresses: string[];
  tokenIns: string[];
  tokenOuts: string[];
  zeroForOnes: boolean[];
};

export type SerializedTopologyEdge = {
  protocol: string;
  protocolKind?: string | null;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  zeroForOne: boolean;
  fee?: number | bigint | string | null;
  swapFeeBps?: number | null;
  feeDenominator?: number | bigint | string | null;
  feeBps?: number | null;
  stateRef?: RouteState | null;
};

export type SerializedTopology = Record<string, SerializedTopologyEdge[]>;
export type WorkerStateObject = Record<string, RouteState>;
export type EvaluationResult = {
  path: SerializedEvaluationPath;
  result: RouteSimulationResult;
};

export type WorkerEvaluatePayload = {
  type: "EVALUATE";
  paths: SerializedEvaluationPath[];
  stateObj?: WorkerStateObject;
  testAmount: string;
  options?: EvaluatePathsOptions;
};

export type WorkerSyncStatePayload = {
  type: "SYNC_STATE";
  stateObj: WorkerStateObject;
  retainPools: string[];
};

export type WorkerSyncTopologyPayload = {
  type: "SYNC_TOPOLOGY";
  adjacency: SerializedTopology;
  topologyKey?: string | null;
};

export type WorkerEnumeratePayload = {
  type: "ENUMERATE";
  adjacency?: SerializedTopology;
  topologyKey?: string | null;
  startTokens: string[];
  options?: Record<string, unknown>;
};

export type WorkerPayload =
  | WorkerEvaluatePayload
  | WorkerSyncStatePayload
  | WorkerSyncTopologyPayload
  | WorkerEnumeratePayload;

export type WorkerRequest = WorkerPayload & { id: number };

export type WorkerEvaluateResponse = {
  id: number;
  type: "EVALUATE";
  profitable: EvaluationResult[];
};

export type WorkerEnumerateResponse = {
  id: number;
  type: "ENUMERATE";
  paths: SerializedEnumeratedPath[];
};

export type WorkerAckResponse = {
  id: number;
  type: "SYNC_STATE" | "SYNC_TOPOLOGY";
};

export type WorkerErrorResponse = {
  id: number;
  error: string;
};

export type WorkerResponse =
  | WorkerEvaluateResponse
  | WorkerEnumerateResponse
  | WorkerAckResponse
  | WorkerErrorResponse;

export type WorkerResult = EvaluationResult[] | SerializedEnumeratedPath[] | true;
