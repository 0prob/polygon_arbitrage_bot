import { indexer } from "envio";
import { fetchCurveMetadata } from "../effects/curve_metadata.ts";

const HUB_TOKENS = new Set([
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC_NATIVE
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
]);

indexer.contractRegister(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }: any) => {
    const pool = event.params.pool.toLowerCase();
    const meta = await context.effect(fetchCurveMetadata, { pool, nCoins: 8 });
    if (meta.coins.some(t => HUB_TOKENS.has(t))) {
      context.chain.CurvePool.add(event.params.pool);
    }
  },
);

indexer.onEvent(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }: any) => {
    const pool = event.params.pool.toLowerCase();
    const meta = await context.effect(fetchCurveMetadata, { pool, nCoins: 8 });
    if (!meta.coins.some(t => HUB_TOKENS.has(t))) return;
    
    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "curve",
      tokens: meta.coins,
      token0: meta.coins[0] || "",
      token1: meta.coins[1] || "",
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
    });

    context.CurvePoolState.set({
      id: pool,
      address: pool,
      lastUpdatedBlock: Number(event.block.number),
      balances: meta.balances,
      A: meta.A,
      fee: meta.fee,
    });
  },
);
