import type { Address } from "../core/types/common.ts";
import type { PoolMeta, PoolState } from "../core/types/pool.ts";
import type { FlashLoanSource } from "../core/types/execution.ts";
import type { ProfitAssessment } from "../core/types/execution.ts";
import type { RouteSimulationResult } from "../core/types/route.ts";

export const DEFAULT_FEE_BPS = 30n;

export interface SwapEdge {
  poolAddress: Address;
  protocol: string;
  tokenIn: Address;
  tokenOut: Address;
  feeBps: bigint;
  stateRef?: unknown;
  zeroForOne: boolean;
  tokenInIdx: number;
  tokenOutIdx: number;
}

export interface RoutingGraph {
  adjacency: Map<string, SwapEdge[]>;
  poolMeta: Map<string, PoolMeta>;
  stateRefs: Map<string, unknown>;
  tokens: Set<string>;
}

export interface FoundCycle {
  id?: string;
  startToken: Address;
  edges: SwapEdge[];
  hopCount: number;
  logWeight: number;
  cumulativeFeeBps: bigint;
}

export interface PipelineOptions {
  minProfitMaticWei: bigint;
  gasPriceWei: bigint;
  tokenToMaticRates: Map<string, bigint>;
  tokenMetas?: Map<string, { decimals: number }>;
  slippageBps?: bigint;
  revertRiskBps?: bigint;
  /** Flash loan source — required because the entire arbitrage architecture is flash-loan dependent (no capital-backed paths exist). amountIn in simulations is the flash principal. */
  flashLoanSource: FlashLoanSource;
  ternarySearchIterations?: number;
  maxPriceImpactThreshold?: number;
  concurrency?: number;
  roiSafetyCap?: number;
  logger?: any;
  onProgress?: (current: number, total: number, profitable: number) => void;
}

export interface PipelineResult {
  profitable: Array<{
    cycle: FoundCycle;
    result: RouteSimulationResult;
    assessment: ProfitAssessment;
  }>;
  attempted: number;
  profitableCount: number;
  simulated: number;
  pruned: number;
  noRate: number;
  maxGrossProfitMatic?: bigint;
}

export interface SimulationEdge {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  protocol: string;
  zeroForOne: boolean;
  fee?: number | bigint | string | null;
  swapFeeBps?: number | null;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  stateRef?: PoolState | null;
}

export interface StateSnapshot {
  pools: Map<string, Record<string, unknown>>;
  tokenDecimals: Map<string, number>;
  timestamp: number;
}
