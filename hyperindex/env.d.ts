declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * Comma-separated RPC URLs for on-chain reads inside effects (token decimals at historical blocks,
     * Balancer/Curve/DODO metadata, etc). The main bot performs archival-probe filtering and removes
     * any endpoints that fail historical calls before passing here (prefers .env entries, falls back
     * to free public only after removing unsupported).
     *
     * POLYGON_RPC_URLS (preferred, comma sep) or POLYGON_RPC_URL (singular) both accepted.
     *
     * The effects client will use viem fallback() across the list for resilience.
     *
     * Recommended: set POLYGON_RPC_URLS in root .env to your reliable (preferably archival) providers.
     * Free public are only used as last resort after filtering.
     */
    POLYGON_RPC_URLS?: string;
    POLYGON_RPC_URL?: string;
  }
}

declare var process: {
  env: NodeJS.ProcessEnv;
};
