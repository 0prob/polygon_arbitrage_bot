import { encodeFunctionData, decodeFunctionData } from "viem";
import { V3_POOL_SWAP_ABI } from "../src/services/execution/calldata/abis.ts";

const amountIn = 101431184270690444n;
const recipient = "0xB40bc458b819139bB5cAeE2cc12759F38F5566Ad";
const zeroForOne = true;
const sqrtPriceLimitX96 = 72833950442657788314468491494n;
const callbackData = "0x00";

const encoded = encodeFunctionData({
  abi: V3_POOL_SWAP_ABI,
  functionName: "swap",
  args: [recipient, zeroForOne, -amountIn, sqrtPriceLimitX96, callbackData],
});

console.log("Encoded calldata:", encoded);

const decoded = decodeFunctionData({
  abi: V3_POOL_SWAP_ABI,
  data: encoded,
});

const args = decoded.args as any[];
console.log("Decoded amountSpecified:", args[2]);
console.log("Is negative?", (args[2] as bigint) < 0n);
