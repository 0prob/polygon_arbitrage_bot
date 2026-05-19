import { indexer } from "envio";

indexer.contractRegister(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    (context.chain as any).CurvePool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    context.PoolMeta.set({
      id: event.params.pool.toLowerCase(),
      address: event.params.pool.toLowerCase(),
      protocol: "curve",
      tokens: [],
      token0: "",
      token1: "",
      createdBlock: event.block.number,
    });
  },
);
