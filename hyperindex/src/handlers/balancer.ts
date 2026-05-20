import { indexer } from "envio";
import { fetchBalancerMetadata } from "../effects/balancer_metadata.ts";

const HUB_TOKENS = new Set([
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC_NATIVE
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
]);

indexer.onEvent(
  { contract: "BalancerVault", event: "PoolRegistered" },
  async ({ event, context }: any) => {
    const pool = event.params.poolAddress.toLowerCase();
    const poolId = event.params.poolId.toLowerCase();
    const meta = await context.effect(fetchBalancerMetadata, { pool });
    
    if (!meta.tokens.some(t => HUB_TOKENS.has(t))) return;

    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "balancer_v2",
      tokens: meta.tokens,
      token0: meta.tokens[0] || "",
      token1: meta.tokens[1] || "",
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
      swapFee: 0n,
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "TokensRegistered" },
  async ({ event, context }: any) => {
    const tokens = event.params.tokens.map((t: string) => t.toLowerCase());
    if (!tokens.some(t => HUB_TOKENS.has(t))) return;

    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    context.PoolMeta.set({
      id: mapping.address,
      address: mapping.address,
      protocol: "balancer_v2",
      tokens: tokens,
      token0: tokens[0] || "",
      token1: tokens[1] || "",
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: poolId,
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "Swap" },
  async ({ event, context }: any) => {
    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    const poolAddr = mapping.address;
    const [state, meta] = await Promise.all([
      context.BalancerPoolState.get(poolAddr),
      context.PoolMeta.get(poolAddr)
    ]);

    if (!state || !meta) {
      // Fallback to effect if state missing (initialization)
      const metaEffect = await context.effect(fetchBalancerMetadata, { pool: poolAddr });
      context.BalancerPoolState.set({
        id: poolAddr,
        address: poolAddr,
        lastUpdatedBlock: Number(event.block.number),
        poolId: poolId,
        balances: metaEffect.balances,
        swapFee: 0n,
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

    if (idxIn >= 0) balances[idxIn] += aIn;
    if (idxOut >= 0) balances[idxOut] -= aOut;

    context.BalancerPoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "PoolBalanceChanged" },
  async ({ event, context }: any) => {
    const poolId = event.params.poolId.toLowerCase();
    const mapping = await context.BalancerPoolIdToAddress.get(poolId);
    if (!mapping) return;

    const state = await context.BalancerPoolState.get(mapping.address);
    if (!state) return;

    const amounts = event.params.amounts; // int256[]
    const balances = [...state.balances];

    for (let i = 0; i < balances.length; i++) {
      balances[i] += BigInt(amounts[i] || 0);
    }

    context.BalancerPoolState.set({
      ...state,
      lastUpdatedBlock: Number(event.block.number),
      balances,
    });
  },
);
