import { indexer } from "envio";

indexer.onEvent(
  { contract: "BalancerVault", event: "PoolRegistered" },
  async ({ event, context }: any) => {
    context.PoolMeta.set({
      id: event.params.poolAddress.toLowerCase(),
      address: event.params.poolAddress.toLowerCase(),
      protocol: "balancer_v2",
      tokens: [],
      token0: "",
      token1: "",
      createdBlock: Number(event.block.number),
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "TokensRegistered" },
  async ({ event, context }: any) => {
    context.PoolMeta.set({
      id: event.params.poolId.toLowerCase(), // Note: Balancer often uses poolId as key
      address: event.params.poolId.toLowerCase(),
      protocol: "balancer_v2",
      tokens: event.params.tokens.map((t: string) => t.toLowerCase()),
      token0: (event.params.tokens[0] || "").toLowerCase(),
      token1: (event.params.tokens[1] || "").toLowerCase(),
      createdBlock: Number(event.block.number),
    });
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "PoolBalanceChanged" },
  async ({ event, context }: any) => {
    // This is more complex because we need the current balances
    // For now, we'll just log that it changed
  },
);

indexer.onEvent(
  { contract: "BalancerVault", event: "Swap" },
  async ({ event, context }: any) => {
    // We should ideally update the balances here
  },
);
