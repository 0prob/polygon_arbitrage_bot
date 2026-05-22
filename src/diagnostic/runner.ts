/**
 * Diagnostic Harness — exercises every subsystem in isolation,
 * reports PASS/FAIL/ERROR with timing and context.
 * Run: npx tsx src/diagnostic/runner.ts
 */

const MAX_DIAG_RESULTS = 10_000;
const DIAG_RESULTS: Array<{ name: string; status: string; durationMs: number; detail?: string; error?: string }> = [];
function diag(name: string, fn: () => void | Promise<void>) {
  return async () => {
    const start = Date.now();
    try {
      await fn();
      if (DIAG_RESULTS.length >= MAX_DIAG_RESULTS) DIAG_RESULTS.shift();
      DIAG_RESULTS.push({ name, status: "PASS", durationMs: Date.now() - start });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack?.slice(0, 300)}` : String(err);
      if (DIAG_RESULTS.length >= MAX_DIAG_RESULTS) DIAG_RESULTS.shift();
      DIAG_RESULTS.push({ name, status: "FAIL", durationMs: Date.now() - start, error: msg });
    }
  };
}

type Address = `0x${string}`;

// Checksummed addresses for viem
const ZERO_ADDR = "0x0000000000000000000000000000000000000001" as Address;
const ADDR_A = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address;
const ADDR_B = "0xE592427A0AEce92De3Edee1F18E0157C05861564" as Address;
const ADDR_C = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as Address;
const EXECUTOR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address;

// ── 1. CONFIG ─────────────────────────────────────────────────────────────

import { loadConfig } from "../config/loader.ts";

const BASE_ENV = {
  EXECUTION_RPC: "https://polygon-rpc.com",
  GAS_ESTIMATION_RPC: "https://polygon-rpc.com",
  EXECUTOR_ADDRESS: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  ENVIO_API_TOKEN: "test-token",
  POLYGON_RPC_URLS: "https://polygon-rpc.com",
};

const diagConfig = diag("config/load-defaults", () => {
  const cfg = loadConfig({ ...BASE_ENV });
  if (!cfg.rpc || !cfg.hypersync || !cfg.execution) throw new Error("Config missing sections");
  if (cfg.rpc.polygonRpcUrls.length === 0) throw new Error("No RPC URLs");
});

const diagConfigEdgeCases = diag("config/edge-cases", () => {
  let cfg = loadConfig({ ...BASE_ENV, TUI: "false", DRY_RUN_BEFORE_SUBMIT: "false" });
  if (cfg.observability.tuiEnabled !== false) throw new Error("tuiEnabled should be false");
  if (cfg.execution.dryRunBeforeSubmit !== false) throw new Error("dryRunBeforeSubmit should be false");

  cfg = loadConfig({ ...BASE_ENV, MIN_PROFIT_WEI: "1000000000000000000" });
  if (cfg.execution.minProfitWei !== 1000000000000000000n) throw new Error("minProfitWei bigint");

  cfg = loadConfig({ ...BASE_ENV, ROUTING_MAX_HOPS: "4" });
  if (cfg.routing.maxHops !== 4) throw new Error("maxHops should be 4");

  cfg = loadConfig({ ...BASE_ENV, POLYGON_RPC_URLS: "https://rpc1.com,https://rpc2.com" });
  if (cfg.rpc.polygonRpcUrls.length !== 2) throw new Error("RPC URLs array");
});

// ── 2. DB ─────────────────────────────────────────────────────────────────

import { createInMemoryDatabase } from "../infra/db/connection.ts";
import { ensureSchema } from "../infra/db/schema.ts";
import {
  upsertPoolMeta,
  getPoolMeta,
  getAllPoolStates,
  upsertPoolState,
  getPoolsByProtocol,
  getAllActivePools,
} from "../infra/db/pools.ts";

const diagDbSchema = diag("db/schema-creation", () => {
  const db = createInMemoryDatabase();
  ensureSchema(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Record<string, string>[];
  const names = tables.map((t) => t.name).sort();
  const expected = ["arb_history", "checkpoints", "pool_fees", "pool_state", "pools", "rollback_guard", "token_meta"];
  for (const e of expected) {
    if (!names.includes(e)) throw new Error(`Missing table: ${e}`);
  }
});

const diagDbCrud = diag("db/pool-crud", () => {
  const db = createInMemoryDatabase();
  ensureSchema(db);

  upsertPoolMeta(db, {
    address: EXECUTOR.toLowerCase(),
    protocol: "test_v2",
    tokens: [ADDR_A.toLowerCase(), ADDR_B.toLowerCase()],
  });

  const meta = getPoolMeta(db, EXECUTOR.toLowerCase());
  if (!meta) throw new Error("Pool meta not found");
  if (meta.protocol !== "test_v2") throw new Error("Wrong protocol");

  const byProtocol = getPoolsByProtocol(db, "test_v2");
  if (byProtocol.length !== 1) throw new Error("Expected 1 pool by protocol");

  upsertPoolState(db, EXECUTOR.toLowerCase(), 100, { reserve0: 1000n, reserve1: 2000n });

  const states = getAllPoolStates(db);
  if (states.length !== 1) throw new Error("Expected 1 pool state");
  if (states[0].address !== EXECUTOR.toLowerCase()) throw new Error("Wrong state address");

  const active = getAllActivePools(db);
  if (active.length !== 1) throw new Error("Expected 1 active pool");
});

// ── 3. MATH ───────────────────────────────────────────────────────────────

import { mulDiv, mulDivRoundingUp, divRoundingUp } from "../core/math/full_math.ts";
import { getSqrtRatioAtTick, getTickAtSqrtRatio } from "../core/math/tick_math.ts";
import { computeSwapStep } from "../core/math/swap_math.ts";
import { getV2AmountOut, getV2AmountIn } from "../core/math/uniswap_v2.ts";
import { simulateV3Swap } from "../core/math/uniswap_v3.ts";

const diagMathMulDiv = diag("math/mulDiv", () => {
  let r = mulDiv(10n, 20n, 3n);
  if (r !== 66n) throw new Error(`10*20/3 expected 66, got ${r}`);
  r = mulDivRoundingUp(10n, 20n, 3n);
  if (r !== 67n) throw new Error(`ceil(10*20/3) expected 67, got ${r}`);
  r = divRoundingUp(10n, 3n);
  if (r !== 4n) throw new Error(`ceil(10/3) expected 4, got ${r}`);
  const large = mulDiv(1n << 128n, 1n << 128n, 1n << 64n);
  if (large !== 1n << 192n) throw new Error(`Large mulDiv expected 2^192, got ${large}`);
});

const diagMathTick = diag("math/tick-math", () => {
  const atTick0 = getSqrtRatioAtTick(0);
  if (atTick0 !== 79228162514264337593543950336n) {
    throw new Error(`sqrtRatioAtTick(0) expected 79228162514264337593543950336, got ${atTick0}`);
  }
  const tick = getTickAtSqrtRatio(79228162514264337593543950336n);
  if (tick !== 0) throw new Error(`tick at sqrt(1) expected 0, got ${tick}`);
});

const diagMathV2 = diag("math/v2-amm", () => {
  // amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
  const amountIn = 1000n;
  const reserveIn = 10000n;
  const reserveOut = 20000n;
  const out = getV2AmountOut(amountIn, reserveIn, reserveOut);
  // expected = floor(1000 * 997 * 20000 / (10000 * 1000 + 1000 * 997))
  // = floor(19940000000 / 10997000) = floor(1812.92...) = 1812
  // but actually: 1000*997*20000 = 19,940,000,000; 10000*1000 + 1000*997 = 10,997,000
  // 19,940,000,000 / 10,997,000 = 1813.017... → floor = 1813
  if (out !== 1813n) throw new Error(`V2 amountOut expected 1813, got ${out}`);

  const needed = getV2AmountIn(out, reserveIn, reserveOut);
  if (needed !== 1000n) throw new Error(`V2 amountIn expected 1000, got ${needed}`);
});

const diagMathV3Simulate = diag("math/v3-simulate", () => {
  const state = {
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    liquidity: 1_000_000_000_000n,
    fee: 3000,
    tickSpacing: 60,
    initialized: true,
    ticks: new Map<number, { liquidityGross: bigint; liquidityNet: bigint }>(),
  };
  const result = simulateV3Swap(state, 1_000_000n, true);
  if (result.amountOut <= 0n) {
    // May fail if no ticks initialized — that's OK for isolated test
    throw new Error(`V3 simulate amountOut should be > 0, got ${result.amountOut}. gas=${result.gasEstimate}`);
  }
});

const diagMathV3SwapStep = diag("math/v3-swap-step", () => {
  const sqrtPX96 = 79228162514264337593543950336n;
  const sqrtTarget = 80228162514264337593543950336n;
  const liquidity = 1_000_000_000_000n;
  const step = computeSwapStep(sqrtPX96, sqrtTarget, liquidity, 1_000_000n, 3000n);
  if (step.amountIn <= 0n) throw new Error("Swap step amountIn should be > 0");
  if (step.amountOut <= 0n) throw new Error("Swap step amountOut should be > 0");
  if (step.sqrtRatioNextX96 <= 0n) throw new Error("Invalid sqrtRatioNextX96");
});

// ── 4. PROFIT ASSESSMENT ──────────────────────────────────────────────────

import { computeProfit, tokensToMaticWei, gasCostMaticWei } from "../core/assessment/profit.ts";
import { FlashLoanSource } from "../core/types/execution.ts";

const diagProfitBasic = diag("assessment/profit-basic", () => {
  const result = computeProfit({
    grossProfitInTokens: 100n,
    amountInTokens: 1_000_000n,
    gasUnits: 500_000,
    gasPriceWei: 30_000_000_000n,
    tokenToMaticRate: 1n,
    hopCount: 3,
    minProfitMaticWei: 1n,
    slippageBps: 50n,
    revertRiskBps: 100n,
    flashLoanSource: FlashLoanSource.BALANCER,
  });
  if (result.gasCostWei !== gasCostMaticWei(500000, 30_000_000_000n)) throw new Error("Gas cost mismatch");
  if (result.grossProfit !== tokensToMaticWei(100n, 1n)) throw new Error("Gross profit mismatch");
  if (result.flashLoanFee !== 0n) throw new Error("Balancer flash loan fee should be 0");
  if (result.shouldExecute && result.netProfitAfterGas <= 0n) {
    throw new Error("If shouldExecute, netProfitAfterGas should be > 0");
  }
});

const diagProfitRoi = diag("assessment/profit-roi", () => {
  // 1 MATIC input (10^18 wei), 5% gross profit (500 BPS), token quoted 1:1 with MATIC
  // Gas: 300k * 30 gwei = 0.009 MATIC
  const input = 10n ** 18n;
  const grossPct = 500n; // 5% in basis points
  const gross = (input * grossPct) / 10000n; // 5% of 1 MATIC = 0.05 MATIC
  const r = computeProfit({
    grossProfitInTokens: gross,
    amountInTokens: input,
    gasUnits: 300_000,
    gasPriceWei: 30_000_000_000n,
    tokenToMaticRate: 1n,
    hopCount: 2,
    minProfitMaticWei: 0n,
    flashLoanSource: FlashLoanSource.AAVE_V3,
  });
  if (r.roi <= 0) throw new Error(`ROI should be positive, got ${r.roi}`);
  // flashLoanFee is computed on amountInTokens: (10^18 * 5) / 10000 = 5 * 10^14
  const expectedFee = (input * 5n) / 10000n;
  if (r.flashLoanFee !== expectedFee) throw new Error(`flashLoanFee expected ${expectedFee}, got ${r.flashLoanFee}`);
});

// ── 5. GRAPH + CYCLES ────────────────────────────────────────────────────

import { buildGraph } from "../services/strategy/graph.ts";
import { enumerateCycles } from "../services/strategy/finder.ts";
import type { RouteStateCache } from "../core/types/route.ts";

const diagGraphBasic = diag("strategy/graph-basic", () => {
  const pools = [
    { address: ADDR_A, protocol: "test", token0: ZERO_ADDR, token1: ADDR_B, tokens: [ZERO_ADDR, ADDR_B] },
    { address: ADDR_B, protocol: "test", token0: ADDR_B, token1: ADDR_C, tokens: [ADDR_B, ADDR_C] },
    { address: ADDR_C, protocol: "test", token0: ADDR_C, token1: ZERO_ADDR, tokens: [ADDR_C, ZERO_ADDR] },
  ];
  const stateCache: RouteStateCache = new Map();
  pools.forEach((p) => stateCache.set(p.address.toLowerCase() as any, { reserve0: 10000n, reserve1: 20000n }));
  const graph = buildGraph(pools, stateCache);
  if (graph.tokens.size < 2) throw new Error(`Expected >=2 tokens, got ${graph.tokens.size}`);
  let edgeCount = 0;
  for (const edges of graph.adjacency.values()) edgeCount += edges.length;
  if (edgeCount < 3) throw new Error(`Expected >=3 edges, got ${edgeCount}`);
});

const diagCyclesBasic = diag("strategy/cycle-finding", () => {
  const pools = [
    { address: ADDR_A, protocol: "test", token0: ZERO_ADDR, token1: ADDR_B, tokens: [ZERO_ADDR, ADDR_B] },
    { address: ADDR_B, protocol: "test", token0: ADDR_B, token1: ADDR_C, tokens: [ADDR_B, ADDR_C] },
    { address: ADDR_C, protocol: "test", token0: ADDR_C, token1: ZERO_ADDR, tokens: [ADDR_C, ZERO_ADDR] },
  ];
  const stateCache2: RouteStateCache = new Map();
  pools.forEach((p) => stateCache2.set(p.address.toLowerCase() as any, { reserve0: 10000n, reserve1: 20000n }));
  const graph = buildGraph(pools, stateCache2);
  const cycles = enumerateCycles(graph, 3);
  if (cycles.length === 0) throw new Error("Expected at least 1 cycle in triangle graph");
});

// ── 6. PIPELINE ──────────────────────────────────────────────────────────

import { evaluatePipeline } from "../services/strategy/pipeline.ts";

const diagPipeline = diag("strategy/pipeline-evaluation", () => {
  const pools = [
    { address: ADDR_A, protocol: "quickswap_v2", token0: ZERO_ADDR, token1: ADDR_B, tokens: [ZERO_ADDR, ADDR_B] },
    { address: ADDR_B, protocol: "quickswap_v2", token0: ADDR_B, token1: ADDR_C, tokens: [ADDR_B, ADDR_C] },
    { address: ADDR_C, protocol: "quickswap_v2", token0: ADDR_C, token1: ZERO_ADDR, tokens: [ADDR_C, ZERO_ADDR] },
  ];
  const stateCache: RouteStateCache = new Map();
  pools.forEach((p) =>
    stateCache.set(p.address.toLowerCase() as any, {
      reserve0: 1_000_000n * 10n ** 18n,
      reserve1: 2_000_000n * 10n ** 18n,
      fee: 997n,
      feeDenominator: 1000n,
    }),
  );
  const graph = buildGraph(pools, stateCache);
  const cycles = enumerateCycles(graph, 3);
  if (cycles.length === 0) throw new Error("No cycles found for pipeline");
  const result = evaluatePipeline(cycles, stateCache, {
    minProfitMaticWei: 1n,
    gasPriceWei: 30_000_000_000n,
    tokenToMaticRate: 1n,
    slippageBps: 50n,
    revertRiskBps: 100n,
    flashLoanSource: FlashLoanSource.BALANCER,
  });
  if (result.attempted === 0) throw new Error("Pipeline should attempt evaluation");
});

// ── 7. TRANSACTION BUILDER ────────────────────────────────────────────────

import { buildArbTx } from "../services/execution/builder.ts";

const diagTxBuilder = diag("execution/tx-builder", () => {
  const route = {
    path: {
      startToken: ZERO_ADDR,
      edges: [
        {
          poolAddress: ADDR_A,
          tokenIn: ZERO_ADDR,
          tokenOut: ADDR_B,
          protocol: "quickswap_v2",
          zeroForOne: false,
          fee: 30,
          swapFeeBps: 30,
          tokenInIdx: 0,
          tokenOutIdx: 1,
          metadata: {},
        },
      ],
    },
    result: {
      amountIn: 1_000_000n,
      amountOut: 1_990_000n,
      hopAmounts: [1_000_000n, 1_990_000n],
      tokenPath: [ZERO_ADDR, ADDR_B],
      poolPath: [ADDR_A],
    },
  };
  const built = buildArbTx(route, { executorAddress: EXECUTOR, fromAddress: EXECUTOR });
  if (!built.to || !built.data) throw new Error("Missing to/data in built tx");
  if (!built.routeHash) throw new Error("Missing routeHash");
});

// ── 8. (reserved) ────────────────────────────────────────────────────────

// ── 9. RPC ERROR CLASSIFIERS ──────────────────────────────────────────────

import { isRateLimitError, isAuthError, isRetryableError } from "../infra/rpc/retry.ts";

const diagRpcClassifiers = diag("rpc/error-classifiers", () => {
  if (!isRateLimitError(new Error("429 Too Many Requests"))) throw new Error("Should detect 429");
  if (!isRateLimitError(new Error("rate limit exceeded"))) throw new Error("Should detect rate limit text");
  if (!isAuthError(new Error("401 Unauthorized"))) throw new Error("Should detect 401");
  if (!isAuthError(new Error("403 Forbidden"))) throw new Error("Should detect 403");
  if (!isRetryableError(new Error("ETIMEOUT"))) throw new Error("Should detect timeout");
  if (!isRetryableError(new Error("ECONNREFUSED"))) throw new Error("Should detect conn refused");
  if (!isRetryableError(new Error("socket hang up"))) throw new Error("Should detect socket hang up");
  if (isRetryableError(new Error("401 Unauthorized"))) throw new Error("Should NOT retry auth errors");
});

// ── 10. (reserved) ────────────────────────────────────────────────────────

// ── 11. CALLLDATA ENCODING ────────────────────────────────────────────────

import { encodeExecuteArb, buildFlashParams, computeRouteHash } from "../services/execution/calldata.ts";

const diagCalldata = diag("execution/calldata-encoding", () => {
  const hash = computeRouteHash([{ target: ADDR_A, value: 0n, data: "0xabcdef" as `0x${string}` }]);
  if (!hash || !hash.startsWith("0x")) throw new Error("Invalid route hash");

  const params = buildFlashParams({
    profitToken: ZERO_ADDR,
    minProfit: 1n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    calls: [{ target: ADDR_A, value: 0n, data: "0xabcdef" as `0x${string}` }],
  });
  if (!params.routeHash) throw new Error("buildFlashParams missing routeHash");
  if (!params.calls.length) throw new Error("buildFlashParams should have calls");

  const encoded = encodeExecuteArb({
    flashToken: ZERO_ADDR,
    flashAmount: 1_000_000n,
    profitToken: ZERO_ADDR,
    minProfit: 1n,
    executorAddress: EXECUTOR,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    calls: [{ target: ADDR_A, value: 0n, data: "0xabcdef" as `0x${string}` }],
  });
  if (typeof encoded.to !== "string" || !encoded.data.startsWith("0x")) throw new Error("Invalid encoded arb");
});

// ── 12. SIMULATOR ─────────────────────────────────────────────────────────

import { simulateV2Swap } from "../core/math/uniswap_v2.ts";
import { simulateCurveSwap } from "../core/math/curve.ts";
import { simulateBalancerSwap } from "../core/math/balancer.ts";

const diagSimulateV2 = diag("simulator/v2-swap", () => {
  const result = simulateV2Swap({ reserve0: 10000n, reserve1: 20000n, fee: 997n, feeDenominator: 1000n }, 1000n, true);
  if (result.amountOut <= 0n) throw new Error("V2 swap amountOut should be > 0");
});

const diagSimulateBalancer = diag("simulator/balancer-swap", () => {
  const state = { balances: [10000n, 20000n], weights: [500000, 500000], fee: 0n };
  const result = simulateBalancerSwap(1000n, state, 0, 1);
  if (result.amountOut <= 0n) throw new Error("Balancer swap amountOut should be > 0");
});

const diagSimulateCurve = diag("simulator/curve-swap", () => {
  // Curve StableSwap needs large input relative to pool size (stable math rounds down for tiny amounts)
  const state = { balances: [1_000_000n * 10n ** 18n, 2_000_000n * 10n ** 18n], A: 100n, fee: 0n, nCoins: 2, rates: [1n, 1n] };
  const result = simulateCurveSwap(10n ** 18n, state, 0, 1);
  if (result.amountOut <= 0n) throw new Error("Curve swap amountOut should be > 0, got " + result.amountOut);
});

// ── 13. CORE UTILITIES ────────────────────────────────────────────────────

import { isFastEvmAddress, isPolygonSystemContract } from "../core/identity.ts";
import { bigintToApproxNumber } from "../core/utils/bigint.ts";
import { mapWithConcurrency } from "../core/utils/concurrency.ts";

const diagCoreIdentity = diag("core/identity-checks", () => {
  if (!isFastEvmAddress(ADDR_A)) throw new Error("Valid address should pass");
  if (isFastEvmAddress("0x123")) throw new Error("Short string should not be valid");
  if (isFastEvmAddress(null)) throw new Error("null should not be valid");
  if (isPolygonSystemContract("0x0000000000000000000000000000000000001010")) throw new Error("Should detect system contract");
  if (isPolygonSystemContract(null)) throw new Error("null should not be valid system contract");
});

const diagCoreBigint = diag("core/bigint-utils", () => {
  const r = bigintToApproxNumber(12345678901234567890n, 18);
  if (typeof r !== "number" || r <= 0) throw new Error(`Invalid approx number: ${r}`);
  const r2 = bigintToApproxNumber(5n, 0);
  if (r2 !== 5) throw new Error(`No decimals approx: ${r2}`);
});

const diagCoreConcurrency = diag("core/map-with-concurrency", async () => {
  // mapWithConcurrency(items, concurrency, mapper)
  const results = await mapWithConcurrency([1, 2, 3], 2, async (x: number) => x * 2);
  if (results.length !== 3 || results[0] !== 2 || results[1] !== 4 || results[2] !== 6) {
    throw new Error(`Unexpected results: ${JSON.stringify(results)}`);
  }
});

// ── 14. ASSESSMENT SCORER + OPTIMIZER ────────────────────────────────────

import { rankRoutes } from "../core/assessment/scorer.ts";
import { revertRiskBps, slippageDeduction, flashLoanFee } from "../core/assessment/risk.ts";

const diagScorer = diag("assessment/scorer", () => {
  const routes = [
    {
      path: { edges: [], startToken: "0x1" as Address, hopCount: 2, logWeight: 0, cumulativeFeeBps: 0n },
      result: { amountIn: 1000n, amountOut: 1050n, profit: 50n, totalGas: 300000 },
      assessment: {
        netProfitAfterGas: 10n,
        roi: 100,
        grossProfit: 50n,
        gasCostWei: 40n,
        gasCostInTokens: 40n,
        flashLoanFee: 0n,
        slippageDeduction: 0n,
        revertPenalty: 0n,
        shouldExecute: true,
      },
    },
    {
      path: { edges: [], startToken: "0x1" as Address, hopCount: 3, logWeight: 0, cumulativeFeeBps: 0n },
      result: { amountIn: 1000n, amountOut: 1030n, profit: 30n, totalGas: 500000 },
      assessment: {
        netProfitAfterGas: 5n,
        roi: 50,
        grossProfit: 30n,
        gasCostWei: 35n,
        gasCostInTokens: 35n,
        flashLoanFee: 0n,
        slippageDeduction: 0n,
        revertPenalty: 0n,
        shouldExecute: true,
      },
    },
  ] as any;
  const ranked = rankRoutes(routes);
  if (ranked.length !== 2) throw new Error("Should have 2 ranked routes");
  if (ranked[0].result.profit < ranked[1].result.profit) throw new Error("Higher profit route should rank first");
});

const diagRiskHelpers = diag("assessment/risk-helpers", () => {
  const risk2 = revertRiskBps(2, 100n);
  if (risk2 !== 100n) throw new Error(`2-hop risk expected 100, got ${risk2}`);

  const sd = slippageDeduction(10000n, 50n);
  if (sd !== 50n) throw new Error(`Slippage deduction expected 50, got ${sd}`);

  // flashLoanFee returns (amount * bps) / 10000
  const balFee = flashLoanFee(1000n, FlashLoanSource.BALANCER);
  if (balFee !== 0n) throw new Error(`Balancer fee expected 0, got ${balFee}`);

  const aaveFee = flashLoanFee(100_000n, FlashLoanSource.AAVE_V3);
  // 100000 * 5 / 10000 = 50
  if (aaveFee !== 50n) throw new Error(`Aave fee expected 50 (100000*5/10000), got ${aaveFee}`);
});

// ── 15. PROTOCOL HELPERS ──────────────────────────────────────────────────

import { protocolFamily, isV2Protocol, isV3Protocol, isCurveProtocol, isBalancerProtocol } from "../core/types/protocol.ts";

const diagProtocolHelpers = diag("core/protocol-helpers", () => {
  // protocolFamily uses the FAMILY_KEYS sets which have specific values
  const v2 = protocolFamily("quickswap_v2");
  if (v2 !== "V2") throw new Error(`quickswap_v2 expected V2, got ${v2}`);

  const v3 = protocolFamily("uniswap_v3");
  if (v3 !== "V3") throw new Error(`uniswap_v3 expected V3, got ${v3}`);

  // CURVE_FAMILY_KEYS has "CURVE_MAIN_REGISTRY", not "curve"
  // This is a known inconsistency: stored protocol keys != family key set values
  // simulateHop uses normalizeProtocol() which does startsWith matching
  const curveRegistry = protocolFamily("curve_main_registry");
  if (curveRegistry !== "CURVE") throw new Error(`curve_main_registry expected CURVE, got ${curveRegistry}`);

  const balancer = protocolFamily("balancer_v2");
  if (balancer !== "BALANCER") throw new Error(`balancer_v2 expected BALANCER, got ${balancer}`);

  if (!isV2Protocol("quickswap_v2")) throw new Error("isV2Protocol false for quickswap_v2");
  if (!isV3Protocol("uniswap_v3")) throw new Error("isV3Protocol false for uniswap_v3");
  if (!isCurveProtocol("curve_main_registry")) throw new Error("isCurveProtocol false for curve_main_registry");
  if (!isBalancerProtocol("balancer_v2")) throw new Error("isBalancerProtocol false for balancer_v2");
});

// ── 16. ROUTE CACHE ──────────────────────────────────────────────────────

import { RouteCache } from "../services/strategy/cache.ts";

const diagRouteCache = diag("strategy/route-cache", () => {
  const cache = new RouteCache(100, 5000);
  const stats = cache.getStats();
  if (typeof stats.size !== "number") throw new Error("Cache stats missing size");

  // update expects { path: FoundCycle, profit: bigint }[]
  cache.update([
    {
      path: {
        startToken: ZERO_ADDR,
        edges: [{ poolAddress: ADDR_A, tokenIn: ZERO_ADDR, tokenOut: ADDR_B, protocol: "v2", feeBps: 30n, stateRef: {} }],
        hopCount: 1,
        logWeight: 0,
        cumulativeFeeBps: 30n,
      },
      profit: 100n,
    },
  ]);
  if (cache.getStats().size !== 1) throw new Error("Cache should have 1 entry after update");

  const changed = new Set<string>([ADDR_A.toLowerCase()]);
  const found = cache.getByPools(changed);
  if (found.length !== 1) throw new Error("Should find cache entry by pool");
});

// ── 17. (reserved) ────────────────────────────────────────────────────────

// ── 18. ISOMORPHIC STRING/BIGINT HANDLING ────────────────────────────────

import { stringifyWithBigInt, parseJson, rehydrateStateData } from "../infra/db/codec.ts";

const diagCodec = diag("infra/codec", () => {
  const str = stringifyWithBigInt({ a: 1n, b: "hello", c: [1n, 2n] });
  if (typeof str !== "string") throw new Error("stringifyWithBigInt should return string");
  const parsed = JSON.parse(str);
  if (parsed.a !== "1") throw new Error("BigInt should be stringified");

  // parseJson with valid JSON string
  const result = parseJson<string[]>('["x","y"]', []);
  if (!Array.isArray(result)) throw new Error("parseJson should parse array");
  if (result.length !== 2) throw new Error("parseJson array wrong length");

  // rehydrateStateData
  const rehydrated = rehydrateStateData("test", { big: "12345678901234567890" });
  if (typeof rehydrated !== "object") throw new Error("rehydrateStateData should return object");
});

// ── 19. END-TO-END ROUTE ─────────────────────────────────────────────────

const diagEndToEnd = diag("e2e/discover-graph-execute", async () => {
  const pools = [
    { address: ADDR_A, protocol: "quickswap_v2", token0: ZERO_ADDR, token1: ADDR_B, tokens: [ZERO_ADDR, ADDR_B] },
    { address: ADDR_B, protocol: "quickswap_v2", token0: ADDR_B, token1: ADDR_C, tokens: [ADDR_B, ADDR_C] },
    { address: ADDR_C, protocol: "quickswap_v2", token0: ADDR_C, token1: ZERO_ADDR, tokens: [ADDR_C, ZERO_ADDR] },
  ];
  const reserves = { reserve0: 1_000_000n * 10n ** 18n, reserve1: 2_000_000n * 10n ** 18n };
  const stateCache: RouteStateCache = new Map();
  pools.forEach((p) => stateCache.set(p.address.toLowerCase() as any, { ...reserves, fee: 997n, feeDenominator: 1000n }));

  const graph = buildGraph(pools, stateCache);
  const cycles = enumerateCycles(graph, 3);
  if (cycles.length === 0) throw new Error("E2E: no cycles found");

  const result = evaluatePipeline(cycles, stateCache, {
    minProfitMaticWei: 1n,
    gasPriceWei: 30_000_000_000n,
    tokenToMaticRate: 1n,
    slippageBps: 50n,
    flashLoanSource: FlashLoanSource.BALANCER,
  });
  if (result.attempted === 0) throw new Error("E2E: pipeline evaluated nothing");

  if (result.profitable.length > 0) {
    const p = result.profitable[0];
    const routeInput = {
      path: {
        startToken: p.cycle.startToken,
        edges: p.cycle.edges.map((e: any) => ({
          ...e,
          zeroForOne: false,
          fee: Number(e.feeBps),
          swapFeeBps: Number(e.feeBps),
          tokenInIdx: 0,
          tokenOutIdx: 1,
          metadata: {},
        })),
      },
      result: {
        amountIn: p.result.amountIn,
        amountOut: p.result.amountOut,
        hopAmounts: p.result.hopAmounts,
        tokenPath: p.result.tokenPath,
        poolPath: p.result.poolPath,
      },
    };
    const built = buildArbTx(routeInput, { executorAddress: EXECUTOR, fromAddress: EXECUTOR });
    if (!built.to || !built.data) throw new Error("E2E: tx build missing to/data");
  }
});

// ── RUN ALL ──────────────────────────────────────────────────────────────

const ALL_TESTS = [
  diagConfig,
  diagConfigEdgeCases,
  diagDbSchema,
  diagDbCrud,
  diagMathMulDiv,
  diagMathTick,
  diagMathV2,
  diagMathV3Simulate,
  diagMathV3SwapStep,
  diagProfitBasic,
  diagProfitRoi,
  diagGraphBasic,
  diagCyclesBasic,
  diagPipeline,
  diagTxBuilder,
  // diagStateOps (removed - watcher/state_ops deleted),
  // diagValidatePoolState (removed - watcher/state_ops deleted),
  diagRpcClassifiers,
  // diagDecoderBasic (removed - discovery/decoder deleted),
  // diagDecoderV3 (removed - discovery/decoder deleted),
  // diagDecoderBalancer (removed - discovery/decoder deleted),
  // diagDecoderCurve (removed - discovery/decoder deleted),
  diagCalldata,
  diagSimulateV2,
  diagSimulateBalancer,
  diagSimulateCurve,
  diagCoreIdentity,
  diagCoreBigint,
  diagCoreConcurrency,
  diagScorer,
  diagRiskHelpers,
  diagProtocolHelpers,
  diagRouteCache,
  // diagFeeResolvers (removed - watcher/state_ops deleted),
  diagCodec,
  diagEndToEnd,
];

async function main() {
  const startedAt = Date.now();
  for (const test of ALL_TESTS) {
    await test();
  }
  const totalMs = Date.now() - startedAt;

  const passed = DIAG_RESULTS.filter((r) => r.status === "PASS").length;
  const failed = DIAG_RESULTS.filter((r) => r.status === "FAIL").length;

  console.log("\n" + "=".repeat(72));
  console.log("DIAGNOSTIC RESULTS");
  console.log("=".repeat(72));
  for (const r of DIAG_RESULTS) {
    const icon = r.status === "PASS" ? "✓" : "✗";
    console.log(`  ${icon} ${r.name.padEnd(35)} ${r.status.padEnd(5)} ${r.durationMs}ms`);
    if (r.error) {
      console.log(`     ${r.error.slice(0, 200).replace(/\n/g, "\n     ")}`);
    }
  }
  console.log("=".repeat(72));
  console.log(`  Total: ${DIAG_RESULTS.length} | PASS: ${passed} | FAIL: ${failed} | ${totalMs}ms`);
  console.log("=".repeat(72));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Diagnostic harness crashed:", err);
  process.exit(1);
});
