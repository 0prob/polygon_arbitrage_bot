import type { CrossChainRoute, KatanaPoolState, PolygonPoolState } from "./types.ts";
import type { RouteStateCache } from "../../core/types/route.ts";

export interface CrossChainScannerConfig {
  katanaRpcUrl: string;
  escrowToken: `0x${string}`;
  escrowAmount: bigint;
  minProfitBps: number;
  maxSwapHops: number;
}

const HIGH_VALUE_ASSETS = new Set([
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH on Polygon
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC on Polygon
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC on Polygon
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT on Polygon
]);

const USDC_ADDR = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";

const Q192 = 1n << 192n;
const SCALE = 10n ** 18n;

const V3_PROTOCOLS = new Set(["UNISWAP_V3", "SUSHISWAP_V3", "QUICKSWAP_V3", "KYBERSWAP_ELASTIC", "V3"]);

function isV3Protocol(protocol: string): boolean {
  const u = protocol.toUpperCase();
  if (V3_PROTOCOLS.has(u)) return true;
  return u.includes("V3") && !u.includes("V2");
}

function computeV2Price(reserve0: bigint, reserve1: bigint, goldenIsToken0: boolean): bigint | null {
  if (goldenIsToken0) {
    if (reserve0 <= 0n) return null;
    return (reserve1 * SCALE) / reserve0;
  } else {
    if (reserve1 <= 0n) return null;
    return (reserve0 * SCALE) / reserve1;
  }
}

function computeV3Price(sqrtPriceX96: bigint, goldenIsToken0: boolean): bigint | null {
  if (sqrtPriceX96 <= 0n) return null;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  if (goldenIsToken0) {
    return (priceX192 * SCALE) / Q192;
  } else {
    return (Q192 * SCALE) / priceX192;
  }
}

function getPoolPriceInUSDC(token: string, pool: PolygonPoolState | KatanaPoolState): { price: bigint; liquidity: bigint } | null {
  const t0 = (pool as PolygonPoolState).token0?.toLowerCase();
  const t1 = (pool as PolygonPoolState).token1?.toLowerCase();
  if (!t0 || !t1) return null;

  const tok = token.toLowerCase();
  const usdc = USDC_ADDR.toLowerCase();
  const hasAsset = t0 === tok || t1 === tok;
  const hasUsdc = t0 === usdc || t1 === usdc;
  if (!hasAsset || !hasUsdc) return null;

  const goldenIsToken0 = t0 === tok;

  if (isV3Protocol(pool.protocol)) {
    if (!pool.sqrtPriceX96) return null;
    const price = computeV3Price(pool.sqrtPriceX96, goldenIsToken0);
    if (price === null) return null;
    return { price, liquidity: pool.liquidity ?? 0n };
  }

  if (pool.reserve0 === undefined || pool.reserve1 === undefined) return null;
  const price = computeV2Price(pool.reserve0, pool.reserve1, goldenIsToken0);
  if (price === null) return null;

  const liquidity = goldenIsToken0 ? pool.reserve0 : pool.reserve1;
  return { price, liquidity };
}

export class CrossChainScanner {
  private config: CrossChainScannerConfig;

  constructor(config: CrossChainScannerConfig) {
    this.config = config;
  }

  async findProfitableRoutes(
    polygonPools: PolygonPoolState[],
    polygonState: RouteStateCache,
    katanaPools: KatanaPoolState[],
  ): Promise<CrossChainRoute[]> {
    const routes: CrossChainRoute[] = [];

    for (const asset of HIGH_VALUE_ASSETS) {
      const polyPrice = this.getPolygonPrice(asset, polygonPools, polygonState);
      const kataPrice = this.getKatanaPrice(asset as `0x${string}`, katanaPools);
      if (polyPrice === null || kataPrice === null) continue;

      const diff = kataPrice > polyPrice ? kataPrice - polyPrice : polyPrice - kataPrice;
      const profitBps = Number((diff * 10000n) / polyPrice);
      if (profitBps > this.config.minProfitBps) {
        routes.push(this.buildRoute(asset as `0x${string}`, polyPrice, kataPrice, profitBps, katanaPools));
      }
    }
    return routes;
  }

  private getPolygonPrice(token: string, pools: PolygonPoolState[], state: RouteStateCache): bigint | null {
    let bestPrice: bigint | null = null;
    let bestLiquidity = 0n;

    for (const pool of pools) {
      const addr = pool.address.toLowerCase();
      const stateRecord = state.get(addr);
      if (!stateRecord) continue;

      const enriched: PolygonPoolState = {
        address: pool.address,
        protocol: pool.protocol,
        token0: pool.token0,
        token1: pool.token1,
        reserve0: pool.reserve0 ?? (stateRecord.reserve0 as bigint | undefined),
        reserve1: pool.reserve1 ?? (stateRecord.reserve1 as bigint | undefined),
        sqrtPriceX96: pool.sqrtPriceX96 ?? (stateRecord.sqrtPriceX96 as bigint | undefined),
        liquidity: pool.liquidity ?? (stateRecord.liquidity as bigint | undefined),
        tick: pool.tick ?? (stateRecord.tick as number | undefined),
      };

      const result = getPoolPriceInUSDC(token, enriched);
      if (result && result.price > 0n && result.liquidity > bestLiquidity) {
        bestPrice = result.price;
        bestLiquidity = result.liquidity;
      }
    }

    return bestPrice;
  }

  private getKatanaPrice(token: `0x${string}`, pools: KatanaPoolState[]): bigint | null {
    let bestPrice: bigint | null = null;
    let bestLiquidity = 0n;

    for (const pool of pools) {
      const result = getPoolPriceInUSDC(token, pool);
      if (result && result.price > 0n && result.liquidity > bestLiquidity) {
        bestPrice = result.price;
        bestLiquidity = result.liquidity;
      }
    }

    return bestPrice;
  }

  private buildRoute(
    token: `0x${string}`,
    _polyPrice: bigint,
    _kataPrice: bigint,
    profitBps: number,
    pools: KatanaPoolState[],
  ): CrossChainRoute {
    const flashAmount = BigInt(this.config.escrowAmount) * 10n;
    const bestPool = pools.reduce<KatanaPoolState | null>((best, p) => {
      const liq = (p.reserve0 ?? 0n) + (p.reserve1 ?? 0n);
      const bestLiq = best ? (best.reserve0 ?? 0n) + (best.reserve1 ?? 0n) : 0n;
      return liq > bestLiq ? p : best;
    }, null);

    const bestToken1 = bestPool ? bestPool.token1?.toLowerCase() : undefined;
    const swapPath: CrossChainRoute["swapPath"] = bestPool
      ? [
          {
            pool: bestPool.address,
            tokenIn: token,
            tokenOut:
              bestToken1 === token.toLowerCase() ? (bestPool.token0 as `0x${string}`) : ((bestPool.token1 as `0x${string}`) ?? token),
            protocol: bestPool.protocol.includes("V3") ? 3 : 2,
          },
        ]
      : [{ pool: "0x", tokenIn: token, tokenOut: token, protocol: 2 }];

    return {
      escrowToken: this.config.escrowToken,
      escrowAmount: this.config.escrowAmount,
      flashPool: bestPool?.address ?? ("0x" as `0x${string}`),
      flashProtocol: bestPool?.protocol.includes("V3") ? 3 : 2,
      flashAmount,
      swapPath,
      profitToken: token,
      expectedProfit: (flashAmount * BigInt(profitBps)) / 10000n,
      minProfitOut: (flashAmount * BigInt(Math.max(profitBps - 10, 0))) / 10000n,
    };
  }
}
