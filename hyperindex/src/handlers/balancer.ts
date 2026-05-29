import { indexer } from "envio";
import { fetchBalancerMetadata } from "../effects/balancer_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { createHotBiasWhere, INDEXER_HOT_BIAS } from "../utils/hot_tokens";

const balancerMetaCache = new Map<string, { tokens: string[]; fee: number }>();
const balancerIdToAddrCache = new Map<string, string>();

indexer.onEvent(
  {
    contract: "BalancerVault",
    event: "PoolRegistered",
    where: createHotBiasWhere(INDEXER_HOT_BIAS, ["poolAddress", "poolAddress"]),
  },
  async ({ event, context }) => {
    const pool = event.params.poolAddress.toLowerCase();
    const poolId = event.params.poolId.toLowerCase();

    // All effects scheduled early → participate in Envio v3 preload batching + dedup.
    const meta = await context.effect(fetchBalancerMetadata, { pool, poolId, blockNumber: BigInt(event.block.number) });

    if (context.isPreload) {
      return;
    }

    const fee = meta.swapFee > 0n ? Number(meta.swapFee / 10n ** 14n) : 0;
    const tokens = meta.tokens;

    balancerMetaCache.set(pool, { tokens, fee });
    balancerIdToAddrCache.set(poolId, pool);

    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "balancer_v2",
      tokens,
      fee: fee > 0 ? fee : undefined,
      tickSpacing: undefined,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: poolId,
    });

    context.BalancerPoolIdToAddress.set({ id: poolId, address: pool });

    context.BalancerPoolState.set({
      id: pool,
      address: pool,
      lastUpdatedBlock: Number(event.block.number),
      poolId: poolId,
      balances: meta.balances,
      weights: meta.weights,
      amp: meta.amp,
      swapFee: meta.swapFee,
      scalingFactors: meta.scalingFactors,
    });

    // Parallelize token metadata fetches (critical for backfill speed)
    const tokenMetas = await Promise.all(
      meta.tokens.map((token) =>
        context.effect(fetchTokenMeta, {
          address: token,
          blockNumber: BigInt(event.block.number),
        })
      )
    );
    meta.tokens.forEach((token, i) => {
      context.TokenMeta.set({ id: token, address: token, decimals: tokenMetas[i].decimals });
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "TokensRegistered" },
  async ({ event, context }) => {
    const tokens = event.params.tokens.map((t: string) => t.toLowerCase());
    const poolId = event.params.poolId.toLowerCase();

    let poolAddr = balancerIdToAddrCache.get(poolId);
    if (!poolAddr) {
      const mapping = await context.BalancerPoolIdToAddress.get(poolId);
      if (!mapping) return;
      poolAddr = mapping.address;
      balancerIdToAddrCache.set(poolId, poolAddr);
    }

    const existing = await context.PoolMeta.get(poolAddr);
    const fee = existing?.fee ?? 0;
    balancerMetaCache.set(poolAddr, { tokens, fee });

    context.PoolMeta.set({
      id: poolAddr,
      address: poolAddr,
      protocol: "balancer_v2",
      tokens: tokens,
      fee,
      tickSpacing: undefined,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: poolId,
    });

    // Parallelize token metadata fetches (critical for backfill speed)
    const tokenMetas = await Promise.all(
      tokens.map((token) =>
        context.effect(fetchTokenMeta, {
          address: token,
          blockNumber: BigInt(event.block.number),
        })
      )
    );
    tokens.forEach((token, i) => {
      context.TokenMeta.set({ id: token, address: token, decimals: tokenMetas[i].decimals });
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "Swap" },
  async () => {
    // No-op for live debug indexer.
    // Per-event BalancerPoolState writes removed (was contributing to DB write %).
    // Discovery writes (PoolRegistered/TokensRegistered) remain above.
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "PoolBalanceChanged" },
  async () => {
    // No-op for live debug indexer.
  },
);
