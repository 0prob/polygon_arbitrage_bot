const MAX_CACHED_STATE_ENTRIES = 100_000;
const QUERY_LIMIT = 15000;

const _cachedState: Map<string, Record<string, unknown>> = new Map();
const _cacheAccessOrder: string[] = [];
let _lastFetchTime = 0;

export function resetGraphQLReaderCache(): void {
  _cachedState.clear();
  _cacheAccessOrder.length = 0;
  _lastFetchTime = 0;
}

async function graphQLQuery(url: string, secret: string, query: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": secret,
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GraphQL error: ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0]?.message ?? "GraphQL error");
    return json.data;
  } finally {
    clearTimeout(timeoutId);
  }
}

function merge(rows: { id: string }[], mapper: (r: Record<string, unknown>) => Record<string, unknown>): void {
  for (const r of rows) {
    const addr = r.id.toLowerCase();
    const newData = mapper(r as unknown as Record<string, unknown>);
    (newData as Record<string, unknown>).initialized = true;
    const existing = _cachedState.get(addr);
    if (existing) {
      Object.assign(existing, newData);
    } else {
      if (_cachedState.size >= MAX_CACHED_STATE_ENTRIES) {
        const oldest = _cacheAccessOrder.shift()!;
        _cachedState.delete(oldest);
      }
      _cachedState.set(addr, newData as Record<string, unknown>);
      _cacheAccessOrder.push(addr);
    }
  }
}

export async function buildStateCacheFromGraphQL(
  graphqlUrl: string,
  adminSecret: string,
  poolAddresses?: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const now = Date.now();
  if (_cachedState.size > 0 && now - _lastFetchTime < 2000 && !poolAddresses) {
    return _cachedState;
  }

  const whereClause = poolAddresses && poolAddresses.length > 0 
    ? `(where: {id: {_in: ${JSON.stringify(poolAddresses)}}})`
    : `(limit: ${QUERY_LIMIT}, order_by: {lastUpdatedBlock: desc})`;

  try {
    await Promise.all([
      graphQLQuery(graphqlUrl, adminSecret, `{ V3PoolState${whereClause} { id sqrtPriceX96 liquidity tick fee } }`).then(result => {
        const rows = ((result as Record<string, unknown>).V3PoolState) as { id: string; sqrtPriceX96: string; liquidity: string; tick: number; fee: number }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { sqrtPriceX96: BigInt(row.sqrtPriceX96), liquidity: BigInt(row.liquidity), tick: row.tick, fee: row.fee };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ BalancerPoolState${whereClause} { id poolId balances weights amp swapFee scalingFactors } }`).then(result => {
        const rows = ((result as Record<string, unknown>).BalancerPoolState) as { id: string; poolId: string; balances: unknown; weights: unknown; amp: string | null; swapFee: string; scalingFactors: unknown }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return {
            poolId: row.poolId,
            balances: parseBigIntArray(row.balances),
            weights: parseBigIntArray(row.weights),
            amp: row.amp ? BigInt(row.amp) : undefined,
            swapFee: BigInt(row.swapFee),
            scalingFactors: parseBigIntArray(row.scalingFactors),
          };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ V4PoolState${whereClause} { id sqrtPriceX96 liquidity tick fee tickSpacing hooks } }`).then(result => {
        const rows = ((result as Record<string, unknown>).V4PoolState) as { id: string; sqrtPriceX96: string; liquidity: string; tick: number; fee: string; tickSpacing: number; hooks: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return {
            sqrtPriceX96: BigInt(row.sqrtPriceX96), liquidity: BigInt(row.liquidity), tick: row.tick,
            fee: BigInt(row.fee), tickSpacing: row.tickSpacing, hooks: row.hooks,
          };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ CurvePoolState${whereClause} { id balances A fee rates } }`).then(result => {
        const rows = ((result as Record<string, unknown>).CurvePoolState) as { id: string; balances: unknown; A: string; fee: string; rates: unknown }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { balances: parseBigIntArray(row.balances), A: BigInt(row.A), fee: BigInt(row.fee), rates: parseBigIntArray(row.rates) };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ V2PoolState${whereClause} { id reserve0 reserve1 fee } }`).then(result => {
        const rows = ((result as Record<string, unknown>).V2PoolState) as { id: string; reserve0: string; reserve1: string; fee: number }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { reserve0: BigInt(row.reserve0), reserve1: BigInt(row.reserve1), fee: row.fee };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ DodoPoolState${whereClause} { id baseReserve quoteReserve rStatus k fee i targetBase targetQuote lpFeeRate mtFeeRate } }`).then(result => {
        const rows = ((result as Record<string, unknown>).DodoPoolState) as { id: string; baseReserve: string; quoteReserve: string; rStatus: number; k: string; fee: string; i: string; targetBase: string; targetQuote: string; lpFeeRate: string; mtFeeRate: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return {
            baseReserve: BigInt(row.baseReserve), quoteReserve: BigInt(row.quoteReserve), rStatus: row.rStatus,
            k: BigInt(row.k), fee: BigInt(row.fee), i: BigInt(row.i),
            targetBase: BigInt(row.targetBase), targetQuote: BigInt(row.targetQuote),
            lpFeeRate: BigInt(row.lpFeeRate), mtFeeRate: BigInt(row.mtFeeRate),
          };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ WoofiPoolState${whereClause} { id price coefficient spread fee } }`).then(result => {
        const rows = ((result as Record<string, unknown>).WoofiPoolState) as { id: string; price: string; coefficient: string; spread: string; fee: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          // Flattened Woofi state for simplified simulation
          return {
            price: BigInt(row.price), coefficient: BigInt(row.coefficient),
            spread: BigInt(row.spread), fee: BigInt(row.fee),
          };
        });
      }),
    ]);

    _lastFetchTime = Date.now();
  } catch (err) {
    process.stderr.write(`[hyperindex_graphql] buildStateCacheFromGraphQL failed: ${err instanceof Error ? err.message : err}\n`);
  }

  return _cachedState;
}

export interface HasuraPoolMeta {
  address: string;
  protocol: string;
  tokens: string[];
  fee: number;
}

export async function discoverPoolsFromHasura(
  graphqlUrl: string,
  adminSecret: string,
): Promise<HasuraPoolMeta[]> {
  try {
    const activeQuery = `{
      V2PoolState(limit: 5000, order_by: {lastUpdatedBlock: desc}) { id }
      V3PoolState(limit: 5000, order_by: {lastUpdatedBlock: desc}) { id }
      V4PoolState(limit: 1000, order_by: {lastUpdatedBlock: desc}) { id }
      BalancerPoolState(limit: 1000, order_by: {lastUpdatedBlock: desc}) { id }
      CurvePoolState(limit: 1000, order_by: {lastUpdatedBlock: desc}) { id }
      DodoPoolState(limit: 500, order_by: {lastUpdatedBlock: desc}) { id }
      WoofiPoolState(limit: 500, order_by: {lastUpdatedBlock: desc}) { id }
    }`;
    const activeRes = await graphQLQuery(graphqlUrl, adminSecret, activeQuery) as any;
    
    const activeIds = new Set<string>();
    const protocols = ["V2PoolState", "V3PoolState", "V4PoolState", "BalancerPoolState", "CurvePoolState", "DodoPoolState", "WoofiPoolState"];
    
    for (const proto of protocols) {
      const rows = activeRes[proto] || [];
      for (const row of rows) {
        if (row.id) activeIds.add(row.id.toLowerCase());
      }
    }

    if (activeIds.size === 0) return [];
    const idList = Array.from(activeIds);

    const result = await graphQLQuery(
      graphqlUrl,
      adminSecret,
      `{ PoolMeta(where: {id: {_in: ${JSON.stringify(idList)}}}) { id protocol tokens fee } }`,
    );

    const metaArr = (result as Record<string, unknown>).PoolMeta as unknown as { id: string; protocol: string; tokens: unknown; fee: number | null }[];
    if (!metaArr) return [];

    return metaArr.map(pm => {
      let tokens: string[];
      if (typeof pm.tokens === "string") {
        try { tokens = JSON.parse(pm.tokens) as string[]; } catch { tokens = []; }
      } else if (Array.isArray(pm.tokens)) {
        tokens = pm.tokens.map((t: unknown) => String(t));
      } else {
        tokens = [];
      }
      return { 
        address: pm.id.toLowerCase(), 
        protocol: pm.protocol, 
        tokens: tokens.map(t => t.toLowerCase()),
        fee: pm.fee ?? 30,
      };
    });
  } catch (err) {
    process.stderr.write(`[hyperindex_graphql] discoverPoolsFromHasura failed: ${err instanceof Error ? err.message : err}\n`);
    return [];
  }
}

function parseBigIntArray(input: unknown): bigint[] {
  if (Array.isArray(input)) {
    return input.map((b: any) => BigInt(b));
  }
  if (typeof input === "string") {
    try {
      return JSON.parse(input).map((b: string) => BigInt(b));
    } catch {
      return [];
    }
  }
  return [];
}
