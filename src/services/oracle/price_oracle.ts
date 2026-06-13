import type { PublicClient } from "viem";

/** Polygon Chainlink MATIC/USD */
const CHAINLINK_MATIC_USD = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0" as const;

/** Token address -> Chainlink USD feed on Polygon */
const CHAINLINK_FEEDS: Record<string, `0x${string}`> = {
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": CHAINLINK_MATIC_USD,
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "0xfE4A8cc5b5B2369C1C1948aBaC52816A1C139901",
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "0x73366Fe0AA0Ded304479862803e6a4FE8a1621",
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "0x73366Fe0AA0Ded304479862803e6a4FE8a1621",
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": "0xF9680D99D6C9589e2C4124a0F8594FB8B7D415EB",
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": "0xDE31F8bF1478eBF7631D4642793642e358407879",
};

const CHAINLINK_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

const RATE_PRECISION = 10n ** 18n;
/** Polygon Chainlink USD feeds use 8 decimals — avoids a per-feed eth_call. */
const CHAINLINK_USD_DECIMALS = 8;

export interface PriceOracleOptions {
  enabled?: boolean;
  pythHermesUrl?: string;
  maxDivergenceBps?: number;
  client?: PublicClient;
}

export class PriceOracle {
  private maticUsdCache: { value: number; ts: number } | null = null;
  private tokenUsdCache = new Map<string, { value: number; ts: number }>();
  private maticUsdInflight: Promise<number> | null = null;
  private tokenUsdInflight = new Map<string, Promise<number | null>>();
  private readonly ttlMs = 10_000;

  constructor(private options: PriceOracleOptions = {}) {}

  async getMaticUsd(client?: PublicClient): Promise<number> {
    const cached = this.maticUsdCache;
    if (cached && Date.now() - cached.ts < this.ttlMs) return cached.value;

    if (this.maticUsdInflight) return this.maticUsdInflight;

    this.maticUsdInflight = this.fetchMaticUsd(client).finally(() => {
      this.maticUsdInflight = null;
    });
    return this.maticUsdInflight;
  }

  private async fetchMaticUsd(client?: PublicClient): Promise<number> {
    const stale = this.maticUsdCache?.value;
    const c = client ?? this.options.client;
    if (c && this.options.enabled !== false) {
      const usd = await this.readChainlinkUsd(CHAINLINK_MATIC_USD, c);
      if (usd != null && usd > 0) {
        this.maticUsdCache = { value: usd, ts: Date.now() };
        return usd;
      }
    }

    const pyth = await this.fetchPythPrice("Crypto.MATIC/USD");
    if (pyth != null && pyth > 0) {
      this.maticUsdCache = { value: pyth, ts: Date.now() };
      return pyth;
    }

    return stale ?? 0.7;
  }

  private async readChainlinkUsd(feed: `0x${string}`, client: PublicClient): Promise<number | null> {
    try {
      const [, answer] = await client.readContract({
        address: feed,
        abi: CHAINLINK_ABI,
        functionName: "latestRoundData",
      });
      const usd = Number(answer) / 10 ** CHAINLINK_USD_DECIMALS;
      return usd > 0 ? usd : null;
    } catch {
      return null;
    }
  }

  /** token -> MATIC wei per 1 token unit (1e18 scaled) */
  async getTokenToMaticRate(
    token: string,
    poolGraphRate: bigint,
    client?: PublicClient,
    /** When batching oracle lookups, pass a shared MATIC/USD to skip redundant reads. */
    maticUsdHint?: number,
  ): Promise<{ rate: bigint; source: "pool" | "oracle" | "blocked" }> {
    const addr = token.toLowerCase();
    const maticUsd = maticUsdHint ?? (await this.getMaticUsd(client));
    if (maticUsd <= 0) {
      return poolGraphRate > 0n ? { rate: poolGraphRate, source: "pool" } : { rate: 0n, source: "blocked" };
    }

    const tokenUsd = await this.getTokenUsd(addr, client);
    if (tokenUsd == null || tokenUsd <= 0) {
      return poolGraphRate > 0n ? { rate: poolGraphRate, source: "pool" } : { rate: 0n, source: "blocked" };
    }

    const oracleMaticPerToken = (tokenUsd / maticUsd) * Number(RATE_PRECISION);
    const oracleRate = BigInt(Math.floor(oracleMaticPerToken));

    if (poolGraphRate > 0n) {
      const max = poolGraphRate > oracleRate ? poolGraphRate : oracleRate;
      const min = poolGraphRate < oracleRate ? poolGraphRate : oracleRate;
      const divergenceBps = max === 0n ? 0 : Number(((max - min) * 10_000n) / max);
      if (divergenceBps > (this.options.maxDivergenceBps ?? 500)) {
        return { rate: 0n, source: "blocked" };
      }
    }

    return { rate: oracleRate > 0n ? oracleRate : poolGraphRate, source: "oracle" };
  }

  /** Sync read of cached MATIC/USD (for mempool hot path). */
  getCachedMaticUsd(): number | null {
    const cached = this.maticUsdCache;
    if (!cached || Date.now() - cached.ts >= this.ttlMs) return null;
    return cached.value;
  }

  /** Sync read of cached token/USD quotes (for mempool hot path). */
  getCachedTokenUsd(token: string): number | null {
    const cached = this.tokenUsdCache.get(token.toLowerCase());
    if (!cached || Date.now() - cached.ts >= this.ttlMs) return null;
    return cached.value;
  }

  /** Export all non-stale cached token USD prices. */
  exportCachedTokenUsd(): Map<string, number> {
    const out = new Map<string, number>();
    const now = Date.now();
    for (const [token, cached] of this.tokenUsdCache) {
      if (now - cached.ts < this.ttlMs && cached.value > 0) {
        out.set(token, cached.value);
      }
    }
    return out;
  }

  async getTokenUsd(token: string, client?: PublicClient): Promise<number | null> {
    const addr = token.toLowerCase();
    const cached = this.tokenUsdCache.get(addr);
    if (cached && Date.now() - cached.ts < this.ttlMs) return cached.value;

    const inflight = this.tokenUsdInflight.get(addr);
    if (inflight) return inflight;

    const promise = this.fetchTokenUsd(addr, client).finally(() => {
      this.tokenUsdInflight.delete(addr);
    });
    this.tokenUsdInflight.set(addr, promise);
    return promise;
  }

  private async fetchTokenUsd(addr: string, client?: PublicClient): Promise<number | null> {
    const feed = CHAINLINK_FEEDS[addr];
    const c = client ?? this.options.client;
    if (feed && c) {
      const usd = await this.readChainlinkUsd(feed, c);
      if (usd != null && usd > 0) {
        this.tokenUsdCache.set(addr, { value: usd, ts: Date.now() });
        return usd;
      }
    }

    return this.fetchPythPrice(`Crypto.${addr}/USD`);
  }

  private async fetchPythPrice(id: string): Promise<number | null> {
    const url = this.options.pythHermesUrl ?? "https://hermes.pyth.network";
    try {
      const res = await fetch(`${url}/api/latest_price_feeds?ids[]=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Array<{ price: { price: string; expo: number } }>;
      const feed = data[0]?.price;
      if (!feed) return null;
      return Number(feed.price) * 10 ** feed.expo;
    } catch {
      return null;
    }
  }
}

/** Merge oracle-backed rates into pool-graph rates with divergence guard. */
export async function enrichTokenToMaticRates(
  oracle: PriceOracle,
  poolRates: Map<string, bigint>,
  tokens: Iterable<string>,
  client?: PublicClient,
  concurrency = 8,
): Promise<Map<string, bigint>> {
  const out = new Map(poolRates);
  const unique = [...new Set([...tokens].map((t) => t.toLowerCase()))];
  if (unique.length === 0) return out;

  const maticUsd = await oracle.getMaticUsd(client);

  for (let i = 0; i < unique.length; i += concurrency) {
    const chunk = unique.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (key) => {
        const poolRate = poolRates.get(key) ?? 0n;
        const { rate, source } = await oracle.getTokenToMaticRate(key, poolRate, client, maticUsd);
        if (source === "blocked") {
          out.delete(key);
        } else if (rate > 0n) {
          out.set(key, rate);
        }
      }),
    );
  }
  return out;
}
