import { simulateV3Swap } from "./src/core/math/uniswap_v3.ts";

// Simulate a V3 swap with the EXACT state format the fetcher stores
const state = {
  sqrtPriceX96: 2433592838297859816138676n, // ~0.70 USDC per MATIC
  tick: -12345,
  liquidity: 1000000000000000000n, // 1e18
  initialized: true,
};

// feeOverride = 500 (feeBps from PoolMeta for 0.05% pools)
const feeOverride = 500;

console.log("=== V3 Swap Simulation Test ===");
console.log("Fee override:", feeOverride);

// Test zeroForOne (MATIC→USDC)
const result1 = simulateV3Swap(state, 10n * 10n**18n, true, feeOverride);
console.log("\nzeroForOne (MATIC→USDC), amountIn=10 MATIC:");
console.log("  amountOut:", result1.amountOut.toString());
console.log("  amountOut (USDC):", (Number(result1.amountOut) / 1e6).toFixed(6));
console.log("  gasEstimate:", result1.gasEstimate);

// Test !zeroForOne (USDC→MATIC)
const result2 = simulateV3Swap(state, 10n * 10n**6n, false, feeOverride);
console.log("\n!zeroForOne (USDC→MATIC), amountIn=10 USDC:");
console.log("  amountOut:", result2.amountOut.toString());
console.log("  amountOut (MATIC):", (Number(result2.amountOut) / 1e18).toFixed(6));
console.log("  gasEstimate:", result2.gasEstimate);

// Test with NO feeOverride (falls back to state.fee which doesn't exist)
console.log("\n=== Test WITHOUT feeOverride (state.fee missing) ===");
const result3 = simulateV3Swap(state, 10n * 10n**18n, true);
console.log("  amountOut:", result3.amountOut.toString());
console.log("  gasEstimate:", result3.gasEstimate);
console.log("  If amountOut=0, this confirms fee is missing!");

// Test with state.fee present
console.log("\n=== Test WITH state.fee ===");
const stateWithFee = { ...state, fee: 3000n }; // 0.3%
const result4 = simulateV3Swap(stateWithFee, 10n * 10n**18n, true);
console.log("  amountOut:", result4.amountOut.toString());
console.log("  amountOut (USDC):", (Number(result4.amountOut) / 1e6).toFixed(6));

// Test tiny amount (what the bot uses)
console.log("\n=== Test with tiny amount (1 MATIC) ===");
const result5 = simulateV3Swap(state, 1n * 10n**18n, true, feeOverride);
console.log("  amountOut:", result5.amountOut.toString());
console.log("  amountOut (USDC):", (Number(result5.amountOut) / 1e6).toFixed(6));
