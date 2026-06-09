/**
 * Centralized constants for the arbitrage bot and indexer.
 * Source of Truth: hyperindex/src/utils/constants.ts
 */

export type Address = `0x${string}`;

export const RATE_PRECISION = 10n ** 18n;
export const BPS_DENOM = 10000n;
export const BPS_DENOMINATOR = 10000;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Polygon canonical addresses. All lowercase. */

// Token addresses
export const WMATIC: Address = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
export const WETH: Address = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
/** Native USDC (Circle) */
export const USDC: Address = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
export const USDC_NATIVE = USDC;
/** Bridged USDC (USDC.e / PoS) */
export const USDC_E: Address = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
export const USDT: Address = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
export const DAI: Address = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063";
export const WBTC: Address = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";
export const LINK: Address = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39";
export const AAVE: Address = "0xd6df932a45c0f255f85145f286ea0b292b21c90b";
export const CRV: Address = "0x172370d5cd63279efa6d502dab29171933a610af";
export const BAL: Address = "0x9a71012b13ca4d3d0cdcbc8942ec6c4e9e0e6c8c";
export const UNI: Address = "0xb33eaad8d922b1083446dc23f610c2567fb5180f";
export const GHST: Address = "0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7";
export const QUICK: Address = "0xb5c064f955d8e7f38fe0460c556a72987494ee17";
export const TEL: Address = "0xdf7836e3278cdcaf450c33a9254848982424b6e5";
export const SAND: Address = "0xbbba073c31bf03b8acf7c28ef0738decf41bb5df";
export const GRT: Address = "0x5fe2b58c013d7601147dcdd68c143a77499f5531";

// Factory addresses
export const QUICKSWAP_V2_FACTORY: Address = "0x5757371414417b8c6caad45baef941abc7d3ab32";
export const SUSHISWAP_V2_FACTORY: Address = "0xc35dadb65012ec5796536bd9864ed8773abc74c4";
export const DFYN_V2_FACTORY: Address = "0xe7fb3e833efe5f9c441105eb65ef8b261266423b";
export const APESWAP_V2_FACTORY: Address = "0xcf083be4164828f00cae704ec15a36d711491284";
export const MESHSWAP_V2_FACTORY: Address = "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d";
export const JETSWAP_V2_FACTORY: Address = "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7";
export const COMETHSWAP_V2_FACTORY: Address = "0x800b052609c355ca8103e06f022aa30647ead60a";
export const UNISWAP_V2_FACTORY: Address = "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c";

export const UNISWAP_V3_FACTORY: Address = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
export const SUSHISWAP_V3_FACTORY: Address = "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2";
export const QUICKSWAP_V3_FACTORY: Address = "0x411b0facc3489691f28ad58c47006af5e3ab3a28";
export const KYBERSWAP_ELASTIC_FACTORY: Address = "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a";

// Balancer
export const BALANCER_VAULT: Address = "0xba12222222228d8ba445958a75a0704d566bf2c8";

// DODO V2
export const DODO_DVM_FACTORY: Address = "0x79887f65f83bdf15bcc8736b5e5bcdb48fb8fe13";
export const DODO_DPP_FACTORY: Address = "0xdfaf9584f5d229a9dbe5978523317820a8897c5a";
export const DODO_DSP_FACTORY: Address = "0x4d97e480ea49ac57ce8c1f7c79b1a0c3d4adc7c4";

// Aave V3 Polygon
export const AAVE_V3_POOL: Address = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
export const AAVE_V3_POOL_ADDRESSES_PROVIDER: Address = "0xa97684ead0e402dc232d5a977953df7ecbab3cdb";

// Chainlink MATIC/USD feed
export const CHAINLINK_MATIC_USD: Address = "0xab594600376ec9fd91f8e885dadf0ce036862de0";

// Multicall3
export const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";

/**
 * Major high-liquidity tokens on the network.
 * Used as "bases" for rate propagation and prioritizing pool discovery.
 */
export const MAJOR_TOKEN_DATA = {
  WMATIC: { address: WMATIC, approxMaticRate: RATE_PRECISION },
  WETH: { address: WETH, approxMaticRate: RATE_PRECISION * 1000n },
  USDC: { address: USDC, approxMaticRate: RATE_PRECISION * 2n },
  USDC_E: { address: USDC_E, approxMaticRate: RATE_PRECISION * 2n },
  USDT: { address: USDT, approxMaticRate: RATE_PRECISION * 2n },
  DAI: { address: DAI, approxMaticRate: RATE_PRECISION * 2n },
  WBTC: { address: WBTC, approxMaticRate: RATE_PRECISION * 30000n },
  LINK: { address: LINK, approxMaticRate: RATE_PRECISION * 5n },
  AAVE: { address: AAVE, approxMaticRate: RATE_PRECISION * 50n },
  CRV: { address: CRV, approxMaticRate: RATE_PRECISION * 2n },
  BAL: { address: BAL, approxMaticRate: RATE_PRECISION * 3n },
  UNI: { address: UNI, approxMaticRate: RATE_PRECISION * 5n },
  GHST: { address: GHST, approxMaticRate: RATE_PRECISION * 3n },
  QUICK: { address: QUICK, approxMaticRate: RATE_PRECISION * 100n },
  TEL: { address: TEL, approxMaticRate: RATE_PRECISION / 100n },
  SAND: { address: SAND, approxMaticRate: RATE_PRECISION / 2n },
  GRT: { address: GRT, approxMaticRate: RATE_PRECISION / 4n },
} as const;

/** Set of lowercased major token addresses for fast lookup */
export const MAJOR_TOKENS = new Set(Object.values(MAJOR_TOKEN_DATA).map((t) => t.address.toLowerCase()));

/** Map of major token addresses to their approximate MATIC rates for bootstrapping */
export const MAJOR_TOKEN_APPROX_RATES = new Map<string, bigint>(
  Object.values(MAJOR_TOKEN_DATA).map((t) => [t.address.toLowerCase(), t.approxMaticRate]),
);

export const KNOWN_FACTORIES = [
  QUICKSWAP_V2_FACTORY,
  SUSHISWAP_V2_FACTORY,
  UNISWAP_V2_FACTORY,
  DFYN_V2_FACTORY,
  APESWAP_V2_FACTORY,
  MESHSWAP_V2_FACTORY,
  JETSWAP_V2_FACTORY,
  COMETHSWAP_V2_FACTORY,
  UNISWAP_V3_FACTORY,
  SUSHISWAP_V3_FACTORY,
  QUICKSWAP_V3_FACTORY,
  KYBERSWAP_ELASTIC_FACTORY,
  DODO_DVM_FACTORY,
  DODO_DPP_FACTORY,
  DODO_DSP_FACTORY,
];

export const KNOWN_FACTORIES_SET = new Set(KNOWN_FACTORIES.map((a) => a.toLowerCase()));
