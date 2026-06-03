import { encodeRoute, encodeExecuteArb, encodeExecuteArbWithAave, type ExecutorCall } from "./calldata/index.ts";
import { asAddress } from "./calldata/utils.ts";

/**
 * Builds calldata for the flash-loan-only ArbExecutor.
 * Every arb tx starts with a Balancer or Aave flash loan of exactly `route.result.amountIn`.
 * There are no "fund from wallet" or "use contract balance" execution modes.
 * The contract will reject flashAmount==0 with FlashLoanRequired().
 */

export interface BuilderEdgeInput {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  protocol: string;
  zeroForOne?: boolean;
  fee?: number;
  swapFeeBps?: number;
  metadata?: Record<string, unknown>;
  tokenInIdx?: number;
  tokenOutIdx?: number;
  poolId?: string;
  stateRef?: Record<string, unknown>;
}

export interface BuilderRouteInput {
  path: {
    startToken: string;
    edges: BuilderEdgeInput[];
  };
  result: {
    amountIn: bigint;
    amountOut: bigint;
    profit?: bigint;
    hopAmounts: bigint[];
    tokenPath: string[];
    poolPath: string[];
  };
}

export interface BuilderConfig {
  executorAddress: string;
  fromAddress: string;
}

export interface BuilderOptions {
  minProfit?: bigint;
  deadlineOffsetS?: number;
  slippageBps?: number;
  maxCalls?: number;
  /**
   * Flash loan provider for the calldata (encodeExecuteArb vs encodeExecuteArbWithAave).
   * THE ARCHITECTURE IS STRICTLY FLASH-LOAN DEPENDENT: there are no capital-backed execution paths.
   * The executor contract reverts with FlashLoanRequired / FlashLoanOnly if misused.
   * amountIn in the input route/result is the exact flash principal size.
   * Production callers must supply this; default exists only for tests.
   */
  flashLoanSource?: "BALANCER" | "AAVE_V3";
}

export interface BuiltTransaction {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasLimit?: bigint;
  routeHash: `0x${string}`;
  calls: ExecutorCall[];
  meta: Record<string, unknown>;
}

const DEFAULT_DEADLINE_OFFSET_S = 120;
const DEFAULT_MAX_CALLS = 12;

/** Delegates to the single asAddress (viem getAddress) source; returns null instead of throwing for validation paths. */
function normalizeEvmAddress(value: unknown): `0x${string}` | null {
  try {
    return asAddress(value);
  } catch {
    return null;
  }
}

function assertValidRoute(route: BuilderRouteInput): void {
  if (!route?.path || !route?.result) throw new Error("buildArbTx: route path/result required");
  const startToken = normalizeEvmAddress(route.path.startToken);
  if (!startToken) throw new Error("buildArbTx: valid path.startToken required");
  if (!Array.isArray(route.path.edges) || route.path.edges.length === 0) {
    throw new Error("buildArbTx: path.edges must be non-empty");
  }
  const amountIn = route.result.amountIn;
  const amountOut = route.result.amountOut;
  if (amountIn <= 0n) throw new Error("buildArbTx: result.amountIn must be > 0");
  if (amountOut <= 0n) throw new Error("buildArbTx: result.amountOut must be > 0");
  if (route.result.hopAmounts.length !== route.path.edges.length + 1) {
    throw new Error("buildArbTx: hopAmounts length mismatch");
  }
  if (route.result.tokenPath.length !== route.path.edges.length + 1) {
    throw new Error("buildArbTx: tokenPath length mismatch");
  }
  if (route.result.poolPath.length !== route.path.edges.length) {
    throw new Error("buildArbTx: poolPath length mismatch");
  }
}

export function buildArbTx(route: BuilderRouteInput, config: BuilderConfig, options: BuilderOptions = {}): BuiltTransaction {
  const { executorAddress, fromAddress } = config;
  const {
    minProfit = 0n,
    deadlineOffsetS = DEFAULT_DEADLINE_OFFSET_S,
    slippageBps = 50,
    maxCalls = DEFAULT_MAX_CALLS,
    flashLoanSource = "BALANCER",
  } = options;

  if (!executorAddress) throw new Error("buildArbTx: executorAddress required");
  if (!fromAddress) throw new Error("buildArbTx: fromAddress required");
  if (minProfit < 0n) throw new Error("buildArbTx: minProfit must be >= 0");
  if (!Number.isFinite(deadlineOffsetS) || deadlineOffsetS <= 0) throw new Error("buildArbTx: deadlineOffsetS must be > 0");
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("buildArbTx: slippageBps must be between 0 and 10000");
  }
  assertValidRoute(route);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineOffsetS);
  const flashToken = normalizeEvmAddress(route.path.startToken)!;
  const flashAmount = route.result.amountIn;
  const profitToken = flashToken;

  const calls = encodeRoute(route, executorAddress, { slippageBps, deadline });
  if (calls.length > maxCalls) {
    throw new Error(`buildArbTx: route expands to ${calls.length} calls (max ${maxCalls})`);
  }

  const encodedTx =
    flashLoanSource === "AAVE_V3"
      ? encodeExecuteArbWithAave({ executorAddress, flashToken, flashAmount, profitToken, minProfit, deadline, calls })
      : encodeExecuteArb({ executorAddress, flashToken, flashAmount, profitToken, minProfit, deadline, calls });
  const routeHash = encodedTx.routeHash;

  return {
    to: encodedTx.to,
    data: encodedTx.data,
    value: 0n,
    routeHash,
    calls,
    meta: {
      flashToken,
      flashAmount: flashAmount.toString(),
      profitToken,
      minProfit: minProfit.toString(),
      deadline: Number(deadline),
      slippageBps,
      callCount: calls.length,
      routeHash,
      hopCount: route.path.edges.length,
      protocols: route.path.edges.map((e) => e.protocol),
      pools: route.result.poolPath,
      tokens: route.result.tokenPath,
      hopAmounts: route.result.hopAmounts.map(String),
      expectedProfit: String(route.result.profit ?? ""),
    },
  };
}
