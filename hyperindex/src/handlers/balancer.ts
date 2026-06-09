import { indexer } from "envio";
import { fetchBalancerMetadata } from "../effects/balancer_metadata";
import { fetchTokenMeta } from "../effects/token_metadata";
import { logEffectTime } from "../utils/instrumentation";
import { getMetadataConcurrency, runWithConcurrency } from "../utils/pacing";

const balancerMetaCache = new Map<string, { tokens: string[]; fee: number }>();
const balancerIdToAddrCache = new Map<string, string>();

indexer.onEvent(
  {
    contract: "BalancerVault",
    event: "PoolRegistered",
  },
  async ({ event, context }) => {
    const pool = event.params.poolAddress;
    const poolId = event.params.poolId;
    const blockNumber = Number(event.block.number);

    // All effects scheduled early → participate in Envio v3 preload batching + dedup.
    // Token effects moved before isPreload guard (were after) for full preload optimization.
    const tEffBal = Date.now();
    const meta = await context.effect(fetchBalancerMetadata, { pool, poolId, blockNumber: BigInt(blockNumber) });
    logEffectTime("fetchBalancerMetadata", Date.now() - tEffBal, blockNumber);

    // Schedule token metadata effects early (after balancer meta which provides the token list)
    // so they run in the preload phase for batching/memoization.
    //
    // Use runWithConcurrency to respect HYPERSYNC_RPM_TARGET (limits parallel token meta effects).
    const tEffBalTokens = Date.now();
    const concurrency = getMetadataConcurrency();
    const tokenMetas = await runWithConcurrency(meta.tokens, concurrency, (token) => context.effect(fetchTokenMeta, { address: token }));
    logEffectTime("fetchTokenMeta:balancerTokens", Date.now() - tEffBalTokens, blockNumber);

    if (context.isPreload) {
      return;
    }

    const fee = meta.swapFee > 0n ? Number(meta.swapFee / 10n ** 14n) : 0;
    const tokens = [...meta.tokens]; // ensure mutable string[] for cache + PoolMeta type

    balancerMetaCache.set(pool, { tokens, fee });
    balancerIdToAddrCache.set(poolId, pool);

    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "BALANCER_V2",
      tokens,
      fee: fee > 0 ? fee : undefined,
      tickSpacing: undefined,
      createdBlock: blockNumber,
      createdTx: event.transaction.hash,
      poolId: poolId,
    });

    context.BalancerPoolIdToAddress.set({ id: poolId, address: pool });

    context.BalancerPoolState.set({
      id: pool,
      address: pool,
      lastUpdatedBlock: blockNumber,
      poolId: poolId,
      balances: meta.balances,
      weights: meta.weights,
      amp: meta.amp,
      swapFee: meta.swapFee,
      scalingFactors: meta.scalingFactors,
    });

    tokens.forEach((token, i) => {
      context.TokenMeta.set({ id: token, address: token, decimals: tokenMetas[i].decimals });
    });
  },
);

indexer.onEvent({ contract: "BalancerVault", event: "TokensRegistered" }, async ({ event, context }) => {
  const rawTokens = event.params.tokens;
  const tokens = [...rawTokens]; // copy to mutable array to satisfy PoolMeta/cache types + runWithConcurrency
  const blockNumber = Number(event.block.number);

  // Schedule token effects early (tokens come from event params; no extra meta needed)
  // so they get preload batching. DB gets below also benefit from preload.
  //
  // Bounded concurrency for low HYPERSYNC_RPM_TARGET.
  const concurrency = getMetadataConcurrency();
  const tokenMetasPromise = runWithConcurrency(tokens, concurrency, (token) => context.effect(fetchTokenMeta, { address: token }));

  const poolId = event.params.poolId;

  let poolAddr = balancerIdToAddrCache.get(poolId);
  if (!poolAddr) {
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;
    poolAddr = mapping.address;
    balancerIdToAddrCache.set(poolId, poolAddr);
  }

  const existing = await context.PoolMeta.get(poolAddr);
  const fee = existing?.fee ?? 0;

  if (context.isPreload) return;

  balancerMetaCache.set(poolAddr, { tokens, fee });

  context.PoolMeta.set({
    id: poolAddr,
    address: poolAddr,
    protocol: "BALANCER_V2",
    tokens: tokens,
    fee,
    tickSpacing: undefined,
    createdBlock: blockNumber,
    createdTx: event.transaction.hash,
    poolId: poolId,
  });

  const tokenMetas = await tokenMetasPromise;
  tokens.forEach((token, i) => {
    context.TokenMeta.set({ id: token, address: token, decimals: tokenMetas[i].decimals });
  });
});

indexer.onEvent({ contract: "BalancerVault", event: "Swap" }, async ({ event, context }) => {
  const poolId = event.params.poolId;
  let poolAddr = balancerIdToAddrCache.get(poolId);
  if (!poolAddr) {
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;
    poolAddr = mapping.address;
    balancerIdToAddrCache.set(poolId, poolAddr);
  }

  // Preload BalancerPoolState and PoolMeta concurrently
  const [state, meta] = await Promise.all([context.BalancerPoolState.get(poolAddr), context.PoolMeta.get(poolAddr)]);

  if (!state || !meta) return;

  if (context.isPreload) return;

  const tIn = event.params.tokenIn;
  const tOut = event.params.tokenOut;
  const aIn = event.params.amountIn;
  const aOut = event.params.amountOut;

  const tokens = meta.tokens;
  const balances = [...state.balances];

  const idxIn = tokens.indexOf(tIn);
  const idxOut = tokens.indexOf(tOut);

  if (idxIn >= 0) balances[idxIn] += aIn;
  if (idxOut >= 0) balances[idxOut] -= aOut;

  context.BalancerPoolState.set({
    ...state,
    lastUpdatedBlock: Number(event.block.number),
    balances,
  });
});

indexer.onEvent({ contract: "BalancerVault", event: "PoolBalanceChanged" }, async ({ event, context }) => {
  const poolId = event.params.poolId;
  let poolAddr = balancerIdToAddrCache.get(poolId);
  if (!poolAddr) {
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;
    poolAddr = mapping.address;
    balancerIdToAddrCache.set(poolId, poolAddr);
  }

  // Preload BalancerPoolState and PoolMeta concurrently
  const [state, meta] = await Promise.all([context.BalancerPoolState.get(poolAddr), context.PoolMeta.get(poolAddr)]);

  if (!state || !meta) return;

  if (context.isPreload) return;

  const eventTokens = event.params.tokens;
  const amounts = event.params.amounts;
  const metaTokens = meta.tokens;
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
});
