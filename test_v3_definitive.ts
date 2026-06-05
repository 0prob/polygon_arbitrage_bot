// Use the actual bot code to test V3 swap simulation
import type { Address } from "./src/core/types/common.ts";
import type { SwapEdge, SimulationEdge, RouteStateCache } from "./src/pipeline/types.ts";
import { buildSimulationEdges, simulateHop } from "./src/pipeline/simulator.ts";

// Simulate what the bot does: edge from PoolMeta + state from fetcher
const WMATIC = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" as Address;
const USDC = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" as Address;

const poolAddr = "0xa7ff0a0fe10a0cf1c0dd6c1f87a877a6b44773c4"; // QuickSwap V3 WMATIC/USDC 0.05%

// This is the EXACT state format the fetcher stores for V3 pools
const stateCache: RouteStateCache = new Map();
stateCache.set(poolAddr, {
  sqrtPriceX96: 2433592838297859816138676n,
  tick: -12345,
  liquidity: 1000000000000000000n,
  initialized: true,
});

// This is the EXACT SwapEdge that buildSimulationEdges receives
// Note: feeBps comes from PoolMeta.fee (500 for V3 0.05%)
const swapEdge: SwapEdge = {
  poolAddress: poolAddr as Address,
  protocol: "UNISWAP_V3",
  tokenIn: WMATIC,
  tokenOut: USDC,
  feeBps: 500n, // 0.05% from PoolMeta.fee
  stateRef: undefined,
  zeroForOne: true,
  tokenInIdx: 0,
  tokenOutIdx: 1,
};

const simEdges = buildSimulationEdges([swapEdge], stateCache);
if (!simEdges) {
  console.log("FAIL: buildSimulationEdges returned null");
  process.exit(1);
}

console.log("SimulationEdge fee:", simEdges[0].fee);
console.log("SimulationEdge fee type:", typeof simEdges[0].fee);

try {
  const result = simulateHop(simEdges[0], 10n * 10n**18n, stateCache, undefined);
  console.log("\nSUCCESS: simulateHop returned:");
  console.log("  amountOut:", result.amountOut.toString());
  console.log("  gasEstimate:", result.gasEstimate);
  
  if (result.amountOut === 0n) {
    console.log("\nBUG CONFIRMED: V3 swap returns 0 amountOut!");
  } else {
    console.log("\nV3 swap IS working correctly!");
  }
} catch (e: any) {
  console.log("\nFAIL: simulateHop threw:", e.message);
}

// Test with smaller amount (what the low bound test uses)
console.log("\n--- Test with low bound amount (1000 capacity units) ---");
try {
  const result2 = simulateHop(simEdges[0], 1000n, stateCache, undefined);
  console.log("  amountOut:", result2.amountOut.toString());
  if (result2.amountOut === 0n) {
    console.log("  ISSUE: 1000 units → 0 out (may cause all cycles to fail)");
  } else {
    console.log("  Working for small amounts");
  }
} catch (e: any) {
  console.log("  FAIL:", e.message);
}
