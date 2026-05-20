import { indexer } from "envio";

const HUB_TOKENS = new Set([
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WMATIC
  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", // WETH
  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", // USDC
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC_NATIVE
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT
  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", // DAI
  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", // WBTC
]);

async function handleDodoDeployed({ event, context }: any) {
  const base = event.params.baseToken.toLowerCase();
  const quote = event.params.quoteToken.toLowerCase();
  const pool = (event.params.dvm || event.params.dpp || event.params.dsp).toLowerCase();

  if (HUB_TOKENS.has(base) || HUB_TOKENS.has(quote)) {
    context.PoolMeta.set({
      id: pool,
      address: pool,
      protocol: "dodo_v2",
      tokens: [base, quote],
      token0: base,
      token1: quote,
      createdBlock: Number(event.block.number),
      createdTx: event.transaction.hash,
    });
    context.chain.DodoPool.add(pool);
  }
}

indexer.onEvent({ contract: "DodoFactory", event: "DVMDeployed" }, handleDodoDeployed);
indexer.onEvent({ contract: "DodoFactory", event: "DPPDeployed" }, handleDodoDeployed);
indexer.onEvent({ contract: "DodoFactory", event: "DSPDeployed" }, handleDodoDeployed);
