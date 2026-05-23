import { simulateV2Swap } from "./src/core/math/uniswap_v2.ts";

const state = {
  reserve0: 1000n * 10n**18n,
  reserve1: 1000n * 10n**18n,
  initialized: true
};

const amountIn = 10n ** 17n; // 0.1
const zeroForOne = true;

const result = simulateV2Swap(state, amountIn, zeroForOne);

console.log("Input:", amountIn.toString());
console.log("Output:", result.amountOut.toString());
console.log("Profit:", (result.amountOut - amountIn).toString());

if (result.amountOut === 0n) {
  console.error("FAIL: Output is 0");
  process.exit(1);
} else {
  console.log("SUCCESS: Quoter works!");
}
