declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * RPC URL used for on-chain reads inside effects (token decimals, Balancer/Curve/DODO metadata, etc.).
     *
     * Best free / generous free-tier options for Polygon (ranked by batching + multicall quality):
     *
     * 1. Alchemy (recommended) — Sign up for free tier (10M+ compute units/mo). Excellent batching.
     *    Example: https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
     *
     * 2. LlamaRPC (excellent free, no key) — https://polygon.llamarpc.com
     *
     * 3. PublicNode (free, no key) — https://polygon-bor-rpc.publicnode.com
     *
     * 4. Ankr (free tier) — https://rpc.ankr.com/polygon
     *
     * If not set, the indexer defaults to LlamaRPC (very reliable free endpoint).
     */
    POLYGON_RPC_URL?: string;
  }
}

declare var process: {
  env: NodeJS.ProcessEnv;
};
