const MAX_CACHED_STATE_ENTRIES = 100_000;
const QUERY_LIMIT = 10000;

const _cachedState: Map<string, Record<string, unknown>> = new Map();
const _cacheAccessOrder: string[] = [];
let _lastFetchTime = 0;

export function resetGraphQLReaderCache(): void {
  _cachedState.clear();
  _cacheAccessOrder.length = 0;
  _lastFetchTime = 0;
}

async function graphQLQuery(url: string, secret: string, query: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": secret,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message ?? "GraphQL error");
  return json.data;
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
      graphQLQuery(graphqlUrl, adminSecret, `{ V3PoolState${whereClause} { id sqrtPriceX96 liquidity tick } }`).then(result => {
        const rows = ((result as Record<string, unknown>).V3PoolState) as { id: string; sqrtPriceX96: string; liquidity: string; tick: number }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { sqrtPriceX96: BigInt(row.sqrtPriceX96), liquidity: BigInt(row.liquidity), tick: row.tick };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ BalancerPoolState${whereClause} { id poolId balances weights amp swapFee } }`).then(result => {
        const rows = ((result as Record<string, unknown>).BalancerPoolState) as { id: string; poolId: string; balances: unknown; weights: unknown; amp: string | null; swapFee: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return {
            poolId: row.poolId,
            balances: parseBigIntArray(row.balances),
            weights: parseBigIntArray(row.weights),
            amp: row.amp ? BigInt(row.amp) : undefined,
            swapFee: BigInt(row.swapFee),
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

      graphQLQuery(graphqlUrl, adminSecret, `{ CurvePoolState${whereClause} { id balances A fee } }`).then(result => {
        const rows = ((result as Record<string, unknown>).CurvePoolState) as { id: string; balances: unknown; A: string; fee: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { balances: parseBigIntArray(row.balances), A: BigInt(row.A), fee: BigInt(row.fee) };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ V2PoolState${whereClause} { id reserve0 reserve1 } }`).then(result => {
        const rows = ((result as Record<string, unknown>).V2PoolState) as { id: string; reserve0: string; reserve1: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { reserve0: BigInt(row.reserve0), reserve1: BigInt(row.reserve1) };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ DodoPoolState${whereClause} { id baseReserve quoteReserve rStatus k fee } }`).then(result => {
        const rows = ((result as Record<string, unknown>).DodoPoolState) as { id: string; baseReserve: string; quoteReserve: string; rStatus: number; k: string; fee: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { baseReserve: BigInt(row.baseReserve), quoteReserve: BigInt(row.quoteReserve), rStatus: row.rStatus, k: BigInt(row.k), fee: BigInt(row.fee) };
        });
      }),

      graphQLQuery(graphqlUrl, adminSecret, `{ WoofiPoolState${whereClause} { id price coefficient spread fee } }`).then(result => {
        const rows = ((result as Record<string, unknown>).WoofiPoolState) as { id: string; price: string; coefficient: string; spread: string; fee: string }[] | undefined;
        if (rows) merge(rows, r => {
          const row = r as any;
          return { price: BigInt(row.price), coefficient: BigInt(row.coefficient), spread: BigInt(row.spread), fee: BigInt(row.fee) };
        });
      }),
    ]);

    _lastFetchTime = Date.now();
  } catch (err) {
    console.warn("[hyperindex_graphql] buildStateCacheFromGraphQL failed:", err);
  }

  return _cachedState;
}

export interface HasuraPoolMeta {
  address: string;
  protocol: string;
  tokens: string[];
}

export async function discoverPoolsFromHasura(
  graphqlUrl: string,
  adminSecret: string,
): Promise<HasuraPoolMeta[]> {
  try {
    const activeQuery = `{
      V2PoolState(limit: 1000, order_by: {lastUpdatedBlock: desc}) { id }
      V3PoolState(limit: 1000, order_by: {lastUpdatedBlock: desc}) { id }
    }`;
    const activeRes = await graphQLQuery(graphqlUrl, adminSecret, activeQuery) as any;
    
    // Check if V2PoolState or V3PoolState exist in the response
    const v2 = activeRes.V2PoolState || [];
    const v3 = activeRes.V3PoolState || [];
    const activeIds = [
      ...v2.map((p: any) => p.id.toLowerCase()),
      ...v3.map((p: any) => p.id.toLowerCase())
    ];

    if (activeIds.length === 0) return [];

    const result = await graphQLQuery(
      graphqlUrl,
      adminSecret,
      `{ PoolMeta(where: {id: {_in: ${JSON.stringify(activeIds)}}}) { id protocol tokens } }`,
    );

    const metaArr = (result as Record<string, unknown>).PoolMeta as unknown as { id: string; protocol: string; tokens: unknown }[];
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
        tokens: tokens.map(t => t.toLowerCase()) 
      };
    });
  } catch (err) {
    console.warn("[hyperindex_graphql] discoverPoolsFromHasura failed:", err);
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
