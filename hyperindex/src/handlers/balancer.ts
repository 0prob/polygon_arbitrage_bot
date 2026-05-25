import { indexer } from "envio";
import { fetchBalancerMetadata } from "../effects/balancer_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";

indexer.onEvent(
  { contract: "BalancerVault", event: "PoolRegistered" },
  async ({ event, context }) => {
    const pool = event.params.poolAddress.toLowerCase();
    const poolId = event.params.poolId.toLowerCase();

    const meta = await context.effect(fetchBalancerMetadata, { pool, poolId });

    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "balancer_v2",
      tokens: meta.tokens,
      fee: meta.swapFee > 0n ? Number(meta.swapFee / 10n ** 14n) : undefined,
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

    for (const token of meta.tokens) {
      const tMeta = await context.effect(fetchTokenMeta, { address: token });
      context.TokenMeta.set({ id: token, address: token, decimals: tMeta.decimals });
    }
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "TokensRegistered" },
  async ({ event, context }) => {
    const tokens = event.params.tokens.map((t: string) => t.toLowerCase());

    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    const poolAddr = mapping.address;
    const existing = await context.PoolMeta.get(poolAddr);

    context.PoolMeta.set({
      id: poolAddr,
      address: poolAddr,
      protocol: "balancer_v2",
      tokens: tokens,
      fee: existing?.fee ?? 0,
      tickSpacing: undefined,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: poolId,
    });

    for (const token of tokens) {
      const tMeta = await context.effect(fetchTokenMeta, { address: token });
      context.TokenMeta.set({ id: token, address: token, decimals: tMeta.decimals });
    }
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "Swap" },
  async ({ event, context }) => {
    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    const poolAddr = mapping.address;
    const [state, meta] = await Promise.all([
      context.BalancerPoolState.get(poolAddr),
      context.PoolMeta.get(poolAddr),
    ]);

    if (!state || !meta) {
      const metaEffect = await context.effect(fetchBalancerMetadata, { pool: poolAddr, poolId });
      context.BalancerPoolState.set({
        id: poolAddr,
        address: poolAddr,
        lastUpdatedBlock: Number(event.block.number),
        poolId: poolId,
        balances: metaEffect.balances,
        weights: metaEffect.weights,
        amp: metaEffect.amp,
        swapFee: metaEffect.swapFee,
        scalingFactors: metaEffect.scalingFactors,
      });
      return;
    }

    const tIn = event.params.tokenIn.toLowerCase();
    const tOut = event.params.tokenOut.toLowerCase();
    const aIn = event.params.amountIn;
    const aOut = event.params.amountOut;

    const tokens = meta.tokens as string[];
    const balances = [...state.balances];

    const idxIn = tokens.indexOf(tIn);
    const idxOut = tokens.indexOf(tOut);

    if (idxIn >= 0 && balances[idxIn] != null) balances[idxIn] = BigInt(balances[idxIn]) + BigInt(aIn);
    if (idxOut >= 0 && balances[idxOut] != null) balances[idxOut] = BigInt(balances[idxOut]) - BigInt(aOut);

    context.BalancerPoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "PoolBalanceChanged" },
  async ({ event, context }) => {
    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    const poolAddr = mapping.address;
    const [state, meta] = await Promise.all([
      context.BalancerPoolState.get(poolAddr),
      context.PoolMeta.get(poolAddr),
    ]);

    if (!state || !meta) return;

    const eventTokens = event.params.tokens.map((t: string) => t.toLowerCase());
    const amounts = event.params.amounts;
    const metaTokens = meta.tokens as string[];
    const balances = [...state.balances];

    for (let i = 0; i < eventTokens.length; i++) {
      const idx = metaTokens.indexOf(eventTokens[i]);
      const delta = amounts[i];
      if (idx >= 0 && delta != null) {
        balances[idx] = (balances[idx] != null ? BigInt(balances[idx]) : 0n) + BigInt(delta);
      }
    }

    context.BalancerPoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);
