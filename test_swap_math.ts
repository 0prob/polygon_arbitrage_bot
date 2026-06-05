import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });

const reservesAbi = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const slot0Abi = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const liqAbi = parseAbi(["function liquidity() external view returns (uint128)"]);

async function main() {
  const v2Pool = "0x6e7a5fafcec6bb1e78bae2a1f0b612012bf14827"; // QS V2
  const v2Ape = "0xc5f1e5c0e5c22f6a0e7adf739c08e1a87e3b4c65"; // Ape V2
  const v3Pool = "0xa7ff0a0fe10a0cf1c0dd6c1f87a877a6b44773c4"; // QS V3 0.05%
  const v3Uni = "0x374f0a6eaf89aae6d24c3db3da7e2fd45d79e5ed"; // Uni V3 0.05%

  const r = await client.readContract({ address: v2Pool, abi: reservesAbi, functionName: "getReserves" });
  const rApe = await client.readContract({ address: v2Ape, abi: reservesAbi, functionName: "getReserves" });
  const [sQ, lQ] = await Promise.all([
    client.readContract({ address: v3Pool, abi: slot0Abi, functionName: "slot0" }),
    client.readContract({ address: v3Pool, abi: liqAbi, functionName: "liquidity" }),
  ]);
  const [sU, lU] = await Promise.all([
    client.readContract({ address: v3Uni, abi: slot0Abi, functionName: "slot0" }),
    client.readContract({ address: v3Uni, abi: liqAbi, functionName: "liquidity" }),
  ]);

  const r0 = r[0];
  const r1 = r[1];
  const a0 = rApe[0];
  const a1 = rApe[1];

  console.log("=== V2 Pools ===");
  console.log("QS V2 reserve0:", r0.toString(), "reserve1:", r1.toString());
  console.log("Ape V2 reserve0:", a0.toString(), "reserve1:", a1.toString());

  // QS V2: MATIC price in USDC (6 decimals)
  const qsPrice = (Number(r0) / Number(r1)) * 1_000_000; // USDC per MATIC
  const apePrice = (Number(a0) / Number(a1)) * 1_000_000;
  console.log("QS V2 price: 1 MATIC =", (1_000_000 / qsPrice).toFixed(6), "USDC");
  console.log("Ape V2 price: 1 MATIC =", (1_000_000 / apePrice).toFixed(6), "USDC");
  const v2Diff = ((1 / qsPrice - 1 / apePrice) / (1 / apePrice)) * 100;
  console.log("Price diff:", v2Diff.toFixed(6), "%");

  // 2-hop V2 cycle: 10 MATIC in QS V2 → USDC → Ape V2 → MATIC
  const feeNum = 997n;
  const feeDen = 1000n; // 0.3%
  const amountIn = 10n * 10n ** 18n;
  const step1 = (amountIn * feeNum * r1) / (r0 * feeDen + amountIn * feeNum); // USDC out
  const step2 = (step1 * feeNum * a0) / (a1 * feeDen + step1 * feeNum); // MATIC out
  console.log("\nV2 2-hop: 10 MATIC →", (step1 / 10n ** 6n).toString(), "USDC →", (step2 / 10n ** 18n).toString(), "MATIC");
  console.log("Profit:", Number(step2 - amountIn) / 1e18, "MATIC");
  console.log("Profit %:", ((Number(step2 - amountIn) / Number(amountIn)) * 100).toFixed(6));

  console.log("\n=== V3 Pools ===");
  console.log("QS V3 sqrtPriceX96:", sQ[0].toString(), "liquidity:", lQ.toString());
  console.log("Uni V3 sqrtPriceX96:", sU[0].toString(), "liquidity:", lU.toString());

  // V3 price calculation
  function v3Price(sqrtPrice: bigint, dec0: number, dec1: number): number {
    return Number(sqrtPrice ** 2n * 10n ** BigInt(dec1)) / Number(2n ** 192n * 10n ** BigInt(dec0));
  }
  const pQ = v3Price(sQ[0], 18, 6);
  const pU = v3Price(sU[0], 18, 6);
  console.log("QS V3 price: 1 MATIC =", pQ.toFixed(6), "USDC");
  console.log("Uni V3 price: 1 MATIC =", pU.toFixed(6), "USDC");
  const v3Diff = ((pQ - pU) / pU) * 100;
  console.log("Price diff:", v3Diff.toFixed(6), "%");

  // V3 swap estimate: need to compute using liquidity and sqrtPrice
  // amount0 (MATIC) = delta(1/sqrtPrice) * liquidity
  // For 10 MATIC input: delta_sqrtPrice = amount0 / liquidity
  const liqQ = lQ;
  const liqU = lU;
  const inputMatic = 10n * 10n ** 18n; // 10 MATIC
  // V3 swap: amountIn → delta of 1/sqrtPrice
  // amountOut = amountIn * (1 - fee) converted via price
  // For a 0.05% pool: fee = 500 / 1_000_000 = 0.0005
  // Simple estimate: amountOut = amountIn * price * (1 - 0.0005)
  // Actually for zeroForOne (MATIC→USDC):
  // sqrtPrice after = 1 / (1 / sqrtPrice + amountIn * (1 - fee) / liquidity)
  // amountOut = liquidity * (1/sqrtPrice - 1/sqrtPriceAfter)
  const FEE_V3 = 500n; // 0.05%

  function v3SwapExactIn(
    amountIn: bigint,
    sqrtPrice: bigint,
    liquidity: bigint,
    zeroForOne: boolean,
  ): { amountOut: bigint; newSqrtPrice: bigint } {
    const fee = (amountIn * FEE_V3) / 1_000_000n;
    const amountInAfterFee = amountIn - fee;
    if (zeroForOne) {
      // MATIC in, USDC out: 1/sqrtPrice increases
      const oneOverSqrt = 2n ** 192n / sqrtPrice;
      const deltaOneOverSqrt = (amountInAfterFee * 2n ** 192n) / (liquidity * sqrtPrice);
      const newOneOverSqrt = oneOverSqrt + deltaOneOverSqrt;
      const newSqrtPrice = 2n ** 192n / newOneOverSqrt;
      const amountOut = (liquidity * (newOneOverSqrt - oneOverSqrt)) / 2n ** 192n;
      return { amountOut, newSqrtPrice };
    } else {
      // USDC in, MATIC out: sqrtPrice decreases
      const deltaSqrt = (amountInAfterFee * 2n ** 192n) / liquidity;
      const newSqrtPrice = sqrtPrice - deltaSqrt;
      const amountOut = (liquidity * (sqrtPrice - newSqrtPrice) * 2n ** 192n) / ((sqrtPrice * newSqrtPrice * 2n ** 192n) / 2n ** 192n);
      // Simplified: amountOut = liquidity * (sqrtPrice - newSqrtPrice) * 2n**192n / (sqrtPrice * newSqrtPrice)
      return { amountOut, newSqrtPrice };
    }
  }

  // QS V3: zeroForOne (MATIC→USDC)
  const s1 = sQ[0];
  const res1 = v3SwapExactIn(inputMatic, s1, liqQ, true);
  const maticToUsdcAmt = res1.amountOut;
  console.log("\nV3 2-hop: 10 MATIC →", (maticToUsdcAmt / 10n ** 6n).toString(), "USDC via QS V3");

  // Uni V3: !zeroForOne (USDC→MATIC)
  const s2 = sU[0];
  // Actually for the return leg we need amountIn = USDC amount
  // Let's simplify: use price ratio to estimate
  const maticBackEst = BigInt(Math.floor(Number(maticToUsdcAmt) / pU));
  console.log("Estimated MATIC back via Uni V3:", (maticBackEst / 10n ** 18n).toString());
  console.log("Net profit estimate:", maticBackEst - amountIn > 0n ? "PROFIT" : "LOSS", Number(maticBackEst - amountIn) / 1e18, "MATIC");
}

main().catch((e) => console.error(e));
