/** Derive MATIC/USD from stablecoin → MATIC rate map (RATE_PRECISION scale). */
export function computeMaticPriceUsd(tokenToMaticRates: Map<string, bigint>): number {
  let maticPriceUsd = 0.7;
  const usdcAddress = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359".toLowerCase();
  const usdceAddress = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174".toLowerCase();
  const usdtAddress = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f".toLowerCase();
  const daiAddress = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063".toLowerCase();

  const usdcRate =
    tokenToMaticRates.get(usdcAddress) ||
    tokenToMaticRates.get(usdceAddress) ||
    tokenToMaticRates.get(usdtAddress);
  if (usdcRate && usdcRate > 0n) {
    maticPriceUsd = 1e30 / Number(usdcRate);
  } else {
    const daiRate = tokenToMaticRates.get(daiAddress);
    if (daiRate && daiRate > 0n) {
      maticPriceUsd = 1e18 / Number(daiRate);
    }
  }
  return maticPriceUsd;
}
