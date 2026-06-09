/** Global constants for the arbitrage engine. */
export const RATE_PRECISION = 10n ** 18n;
export const BPS_DENOM = 10000n;
export const BPS_DENOMINATOR = 10000;
/**
 * Major high-liquidity tokens on the network.
 * These are used as "bases" for rate propagation and for prioritizing pool discovery.
 * Keep in sync with hyperindex/src/utils/hot_tokens.ts HOT_BASE_TOKENS.
 */
export const MAJOR_TOKEN_DATA = {
  WMATIC: {
    address: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    approxMaticRate: RATE_PRECISION, // 1:1
  },
  WETH: {
    address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    approxMaticRate: RATE_PRECISION * 1000n, // ~1000 MATIC/ETH (conservative)
  },
  USDC: {
    address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    approxMaticRate: RATE_PRECISION * 2n, // ~2 MATIC/USDC
  },
  USDC_E: {
    address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    approxMaticRate: RATE_PRECISION * 2n,
  },
  USDT: {
    address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    approxMaticRate: RATE_PRECISION * 2n,
  },
  DAI: {
    address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
    approxMaticRate: RATE_PRECISION * 2n,
  },
  WBTC: {
    address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    approxMaticRate: RATE_PRECISION * 30000n,
  },
  LINK: {
    address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
    approxMaticRate: RATE_PRECISION * 5n,
  },
  AAVE: {
    address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
    approxMaticRate: RATE_PRECISION * 50n,
  },
  CRV: {
    address: "0x172370d5cd63279efa6d502dab29171933a610af",
    approxMaticRate: RATE_PRECISION * 2n,
  },
  BAL: {
    address: "0x9a71012b13ca4d3d0cdcbc8942ec6c4e9e0e6c8c",
    approxMaticRate: RATE_PRECISION * 3n,
  },
  UNI: {
    address: "0xb33eaad8d922b1083446dc23f610c2567fb5180f",
    approxMaticRate: RATE_PRECISION * 5n,
  },
  GHST: {
    address: "0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7",
    approxMaticRate: RATE_PRECISION * 3n,
  },
  QUICK: {
    address: "0xb5c064f955d8e7f38fe0460c556a72987494ee17",
    approxMaticRate: RATE_PRECISION * 100n,
  },
  TEL: {
    address: "0xdf7836e3278cdcaf450c33a9254848982424b6e5",
    approxMaticRate: RATE_PRECISION / 100n,
  },
  SAND: {
    address: "0xbbba073c31bf03b8acf7c28ef0738decf41bb5df",
    approxMaticRate: RATE_PRECISION / 2n,
  },
  GRT: {
    address: "0x5fe2b58c013d7601147dcdd68c143a77499f5531",
    approxMaticRate: RATE_PRECISION / 4n,
  },
} as const;

/** Set of lowercased major token addresses for fast lookup */
export const MAJOR_TOKENS = new Set(Object.values(MAJOR_TOKEN_DATA).map((t) => t.address.toLowerCase()));

/** Map of major token addresses to their approximate MATIC rates for bootstrapping */
export const MAJOR_TOKEN_APPROX_RATES = new Map<string, bigint>(
  Object.values(MAJOR_TOKEN_DATA).map((t) => [t.address.toLowerCase(), t.approxMaticRate]),
);
