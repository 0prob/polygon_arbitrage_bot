import { indexer } from "envio";
import { fetchTokenMeta } from "../effects/token_metadata";

const FACTORY_PROTOCOLS: Record<string, string> = {
  "0x1f98431c8ad98523631ae4a59f267346ea31f984": "uniswap_v3",
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2": "sushiswap_v3",
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28": "quickswap_v3",
  "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a": "kyberswap_elastic",
};

indexer.contractRegister(
  { contract: "V3Factory", event: "PoolCreated" },
  async ({ event, context }) => {
    context.chain.UniswapV3Pool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "V3Factory", event: "PoolCreated" },
  async ({ event, context }) => {
    const t0 = event.params.token0.toLowerCase();
    const t1 = event.params.token1.toLowerCase();

    const factoryAddr = event.srcAddress.toLowerCase();
    const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "unknown_v3";
    context.PoolMeta.set({
      id: event.params.pool.toLowerCase(),
      address: event.params.pool.toLowerCase(),
      protocol,
      tokens: [t0, t1],
      fee: Number(event.params.fee),
      tickSpacing: Number(event.params.tickSpacing),
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
      poolId: undefined,
    });

    const [t0meta, t1meta] = await Promise.all([
      context.effect(fetchTokenMeta, { address: t0, blockNumber: BigInt(event.block.number) }),
      context.effect(fetchTokenMeta, { address: t1, blockNumber: BigInt(event.block.number) }),
    ]);
    context.TokenMeta.set({ id: t0, address: t0, decimals: t0meta.decimals });
    context.TokenMeta.set({ id: t1, address: t1, decimals: t1meta.decimals });
  },
);
