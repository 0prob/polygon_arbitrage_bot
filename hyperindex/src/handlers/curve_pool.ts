import { indexer } from "envio";

/**
 * Curve pool swap/liquidity events — intentional no-ops for live-debug discovery indexing.
 *
 * Pool metadata + initial CurvePoolState come from curve_factory; hot state from arb bot RPC.
 */
indexer.onEvent({ contract: "CurvePool", event: "TokenExchange" }, async () => {});

indexer.onEvent({ contract: "CurvePool", event: "AddLiquidity" }, async () => {});

indexer.onEvent({ contract: "CurvePool", event: "RemoveLiquidity" }, async () => {});

indexer.onEvent({ contract: "CurvePool", event: "RemoveLiquidityOne" }, async () => {});
