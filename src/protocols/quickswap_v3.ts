/**
 * src/protocols/quickswap_v3.js — QuickSwap V3 protocol definition
 *
 * QuickSwap V3 is built on the Algebra Protocol — a Uniswap V3 variant with
 * dynamic per-pool fees and a different state interface.
 *
 * Key differences from Uniswap V3:
 *   - Pool creation event is `Pool(token0, token1, pool)` — no fee or tickSpacing
 *     in the log; both are fetched on-chain during state polling.
 *   - Pool state uses globalState() instead of slot0() + fee().
 *   - The swap callback is algebraSwapCallback() instead of uniswapV3SwapCallback().
 *     ArbExecutor.sol must implement IAlgebraSwapCallback to execute against
 *     these pools.
 *   - The swap() function ABI is type-compatible with Uniswap V3, so the
 *     calldata encoder (encodeV3Hop) works without modification.
 *
 * Factory: 0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28 (AlgebraFactory on Polygon)
 * Router:  0xf5b509bB0909a69B1c207E495f687a596C168E12 (AlgebraRouter on Polygon)
 */

import { decodedBodyString, decodedIndexedString, type DecodedEvent, type ProtocolDefinition } from "./factories.ts";

const protocol: ProtocolDefinition = {
  name: "QuickSwap V3",
  address: "0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28",
  startBlock: 26000000,
  capabilities: {
    discovery: true,
    routing: true,
    execution: true,
  },
  // Algebra factory emits Pool(token0, token1, pool) — no fee or tickSpacing in event
  signature: "event Pool(address indexed token0, address indexed token1, address pool)",
  decode(decoded: DecodedEvent) {
    // indexed: [token0, token1]; body: [pool]
    return {
      pool_address: decodedBodyString(decoded, 0),
      tokens: [decodedIndexedString(decoded, 0), decodedIndexedString(decoded, 1)],
      metadata: {
        // Fee and tickSpacing are absent from the creation event in Algebra.
        // They are populated during the first state poll via globalState()
        // and tickSpacing(). isAlgebra flags the state fetcher to use the
        // Algebra-specific RPC interface instead of Uniswap V3's slot0().
        fee: null,
        tickSpacing: null,
        isAlgebra: true,
      },
    };
  },
};

export default protocol;
