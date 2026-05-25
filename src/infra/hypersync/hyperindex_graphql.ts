import { RuntimeContext } from "../../orchestrator/system.ts";
import poolsJson from "../../../scripts/pools.json";

export interface HasuraPoolMeta {
  address: string;
  protocol: string;
  tokens: string[];
  fee: number;
}

export const STATIC_ANCHORS: HasuraPoolMeta[] = poolsJson.map((p: any) => ({
  address: p.address,
  protocol: p.protocol,
  tokens: p.tokens,
  fee: p.fee,
}));

export async function graphQLQuery(url: string, adminSecret: string, query: string): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": adminSecret,
    },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    throw new Error(`GraphQL query failed: ${resp.statusText}`);
  }

  const json = (await resp.json()) as any;
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

export interface HasuraPoolState {
  id: string;
  reserve0?: string;
  reserve1?: string;
  sqrtPriceX96?: string;
  tick?: string;
  liquidity?: string;
  initialized: boolean;
}

let _cachedState: Map<string, any> = new Map();

export async function buildStateCacheFromGraphQL(
  graphqlUrl: string,
  adminSecret: string,
): Promise<Map<string, any>> {
  try {
    const [v2Result, v3Result, v4Result, balancerResult, curveResult, dodoResult, woofiResult] = await Promise.all([
      graphQLQuery(graphqlUrl, adminSecret, `{ V2PoolState(limit: 15000) { id reserve0 reserve1 } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ V3PoolState(limit: 15000) { id sqrtPriceX96 tick liquidity } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ V4PoolState(limit: 5000) { id sqrtPriceX96 liquidity tick fee tickSpacing hooks } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ BalancerPoolState(limit: 5000) { id poolId balances weights amp swapFee scalingFactors } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ CurvePoolState(limit: 5000) { id balances A fee rates } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ DodoPoolState(limit: 5000) { id baseReserve quoteReserve rStatus k fee i targetBase targetQuote lpFeeRate mtFeeRate } }`),
      graphQLQuery(graphqlUrl, adminSecret, `{ WoofiPoolState(limit: 5000) { id price coefficient spread fee } }`),
    ]);

    const v2States = (v2Result?.V2PoolState || []) as any[];
    for (const s of v2States) {
      _cachedState.set(s.id.toLowerCase(), {
        reserve0: BigInt(s.reserve0),
        reserve1: BigInt(s.reserve1),
      });
    }

    const v3States = (v3Result?.V3PoolState || []) as any[];
    for (const s of v3States) {
      _cachedState.set(s.id.toLowerCase(), {
        sqrtPriceX96: BigInt(s.sqrtPriceX96),
        tick: Number(s.tick),
        liquidity: BigInt(s.liquidity),
      });
    }

    const v4States = (v4Result?.V4PoolState || []) as any[];
    for (const s of v4States) {
      _cachedState.set(s.id.toLowerCase(), {
        sqrtPriceX96: BigInt(s.sqrtPriceX96),
        liquidity: BigInt(s.liquidity),
        tick: Number(s.tick),
        fee: BigInt(s.fee),
        tickSpacing: Number(s.tickSpacing),
        hooks: s.hooks,
      });
    }

    const balancerStates = (balancerResult?.BalancerPoolState || []) as any[];
    for (const s of balancerStates) {
      _cachedState.set(s.id.toLowerCase(), {
        poolId: s.poolId,
        balances: parseBigIntArray(s.balances),
        weights: parseBigIntArray(s.weights),
        amp: s.amp ? BigInt(s.amp) : undefined,
        swapFee: BigInt(s.swapFee),
        scalingFactors: parseBigIntArray(s.scalingFactors),
      });
    }

    const curveStates = (curveResult?.CurvePoolState || []) as any[];
    for (const s of curveStates) {
      _cachedState.set(s.id.toLowerCase(), {
        balances: parseBigIntArray(s.balances),
        A: BigInt(s.A),
        fee: BigInt(s.fee),
        rates: parseBigIntArray(s.rates),
      });
    }

    const dodoStates = (dodoResult?.DodoPoolState || []) as any[];
    for (const s of dodoStates) {
      _cachedState.set(s.id.toLowerCase(), {
        baseReserve: BigInt(s.baseReserve),
        quoteReserve: BigInt(s.quoteReserve),
        rStatus: s.rStatus,
        k: BigInt(s.k),
        fee: BigInt(s.fee),
        i: BigInt(s.i),
        targetBase: BigInt(s.targetBase),
        targetQuote: BigInt(s.targetQuote),
        lpFeeRate: BigInt(s.lpFeeRate),
        mtFeeRate: BigInt(s.mtFeeRate),
      });
    }

    const woofiStates = (woofiResult?.WoofiPoolState || []) as any[];
    for (const s of woofiStates) {
      _cachedState.set(s.id.toLowerCase(), {
        price: BigInt(s.price),
        coefficient: BigInt(s.coefficient),
        spread: BigInt(s.spread),
        fee: BigInt(s.fee),
      });
    }
  } catch (err) {
    // Silently fail
    console.error("Failed to build state cache from GraphQL", err);
  }

  return _cachedState;
}

export async function discoverPoolsFromHasura(
  graphqlUrl: string,
  adminSecret: string,
): Promise<HasuraPoolMeta[]> {
  const anchors = STATIC_ANCHORS;

  let result: any = null;
  let lastErr: any = null;

  for (let i = 0; i < 5; i++) {
    try {
      result = await graphQLQuery(
        graphqlUrl,
        adminSecret,
        `{ PoolMeta(limit: 2500) { id protocol tokens fee } }`,
      );
      if (result && result.PoolMeta) break;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!result || !result.PoolMeta) {
    if (lastErr) {
      // Just fallback to anchors silently if connection refused
    }
    return anchors;
  }

  try {
    const metaArr = result.PoolMeta as { id: string; protocol: string; tokens: unknown; fee: number | null }[];
    const discovered = metaArr.map(pm => {
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

    const combined = [...anchors];
    const seen = new Set(anchors.map(a => a.address.toLowerCase()));
    for (const p of discovered) {
      if (!seen.has(p.address.toLowerCase())) {
        combined.push(p);
        seen.add(p.address.toLowerCase());
      }
    }
    return combined;
  } catch (err) {
    console.error(`[discoverPoolsFromHasura] Error parsing results:`, err);
    return anchors;
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
