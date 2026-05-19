# HyperIndex Ingestion Layer

Replace the RPC-heavy discovery, hydration, and watcher services with a HyperIndex event-driven ingestion layer. Pool state is updated via on-chain events (Sync, Swap) pushed through HyperSync, eliminating RPC polling for the hot path. The strategy engine reads state from a shared SQLite database.

## Motivation

The current architecture polls RPC endpoints for pool state (getReserves, slot0, liquidity, etc.) every refresh cycle. With limited or unreliable RPC endpoints:

- Pool state is stale between polls → inaccurate profit assessment
- RPC rate limits throttle the number of pools that can be monitored
- Latency from RPC call to tx submission is too high for profitable arbitrage

HyperSync provides event-driven data at ~2000× the speed of RPC, and HyperIndex handles event decoding, reorg protection, and state persistence automatically.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  HyperIndex Framework (new)                              │
│                                                          │
│  config.yaml ──► schema.graphql ──► event handlers       │
│                                          │               │
│  contractRegister:                        │               │
│    PairCreated (V2 factory) ──────────────┤               │
│    PoolCreated (V3 factory) ──────────────┤               │
│    PoolAdded (Curve factory) ─────────────┤               │
│                                          ▼               │
│  onEvent(wildcard):                                      │
│    Sync ──► { reserve0, reserve1 } ──► pool_state DB     │
│    Swap ──► { sqrtPriceX96, liq } ──► pool_state DB      │
│                                                          │
│  createEffect (cached, rate-limited):                    │
│    tokenDecimals() ──► token_meta DB                     │
│    pool A(), fee() ──► pool_state DB (one-time)          │
│    getPoolTokens() ──► pool_state DB (one-time)          │
└──────────────────────┬───────────────────────────────────┘
                       │ writes to
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Shared SQLite Database                                  │
│  ├── pools (address, protocol, tokens, metadata)         │
│  ├── pool_state (address, block, state_data)             │
│  └── token_meta (address, decimals, symbol)              │
└──────────────────────┬───────────────────────────────────┘
                       │ reads from
┌──────────────────────────────────────────────────────────┐
│  Pass Loop (unchanged)                                   │
│                                                          │
│  getPools() → buildGraph() → enumerateCycles()           │
│  → evaluatePipeline() → buildArbTx() → execute()         │
└──────────────────────────────────────────────────────────┘
```

## Files to Create

### `hyperindex/config.yaml`

Chain and contract configuration for Polygon:

```yaml
name: arb_bot_ingestion
networks:
  - id: 137
    startBlock: 0
    contracts:
      - name: UniswapV3Factory
        address: "0x1F98431c8aD98523631AE4a59f267346ea31F984"
        abi_file: abis/uniswap_v3_factory.json
        handler: src/handlers/v3_factory.ts
        events:
          - event: PoolCreated
      - name: UniswapV3Pool
        abi_file: abis/uniswap_v3_pool.json
        handler: src/handlers/v3_pool.ts
        wildcard: true
        events:
          - event: Swap
      - name: QuickswapV2Factory
        address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: UniswapV2Pool
        abi_file: abis/uniswap_v2_pool.json
        handler: src/handlers/v2_pool.ts
        wildcard: true
        events:
          - event: Sync
      # ... remaining V2 factories, V3 factories, Curve, Balancer
```

### `hyperindex/schema.graphql`

Entity definitions for pool metadata and state. State data is stored as concrete fields per protocol type rather than opaque JSON — HyperSync events provide strongly-typed params.

```graphql
type PoolMeta {
  id: ID!
  address: String!
  protocol: String!
  tokens: [String!]!
  token0: String
  token1: String
}

type V2PoolState {
  id: ID!
  address: String!
  lastUpdatedBlock: Int!
  reserve0: BigInt!
  reserve1: BigInt!
}

type V3PoolState {
  id: ID!
  address: String!
  lastUpdatedBlock: Int!
  sqrtPriceX96: BigInt!
  liquidity: BigInt!
  tick: Int!
}

type CurvePoolState {
  id: ID!
  address: String!
  lastUpdatedBlock: Int!
  balances: [BigInt!]!
  A: BigInt!
  fee: BigInt!
  nCoins: Int!
}

type BalancerPoolState {
  id: ID!
  address: String!
  lastUpdatedBlock: Int!
  balances: [BigInt!]!
  poolType: String!
}

type TokenMeta {
  id: ID!
  address: String!
  decimals: Int
}
```

### `hyperindex/src/handlers/v2_factory.ts`

Registers new V2 pools via `contractRegister`:

```typescript
import { indexer } from "envio";

indexer.contractRegister(
  { contract: "QuickswapV2Factory", event: "PairCreated" },
  async ({ event, context }) => {
    context.chain.UniswapV2Pool.add(event.params.pair);
    context.PoolMeta.set({
      id: event.params.pair.toLowerCase(),
      address: event.params.pair.toLowerCase(),
      protocol: "quickswap_v2",
      tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
      token0: event.params.token0.toLowerCase(),
      token1: event.params.token1.toLowerCase(),
    });
  },
);
```

### `hyperindex/src/handlers/v2_pool.ts`

Updates reserves from Sync events:

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Sync", wildcard: true },
  async ({ event, context }) => {
    context.PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      stateData: {
        reserve0: event.params.reserve0.toString(),
        reserve1: event.params.reserve1.toString(),
      },
    });
  },
);
```

### `hyperindex/src/handlers/v3_pool.ts`

Updates tick/liquidity from Swap events:

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Swap", wildcard: true },
  async ({ event, context }) => {
    context.PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      stateData: {
        sqrtPriceX96: event.params.sqrtPriceX96.toString(),
        liquidity: event.params.liquidity.toString(),
        tick: event.params.tick,
      },
    });
  },
);
```

### `hyperindex/src/effects/token_decimals.ts`

One-time RPC effect with caching for token metadata:

```typescript
import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL!, { batch: true }),
});

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

export const fetchTokenDecimals = createEffect(
  {
    name: "fetchTokenDecimals",
    input: { token: S.string },
    output: { decimals: S.number },
    rateLimit: { calls: 10, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    const decimals = await client.readContract({
      address: input.token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    return { decimals: Number(decimals) };
  },
);
```

## Files to Modify

### `src/orchestrator/boot.ts`

- Remove DiscoveryService, HydrationService, WatcherService initialization
- Remove RPC ABI definitions for getReserves, slot0, liquidity
- Remove fetchTokenDecimals, refreshV2PoolState
- Replace with DB-backed pool reader (reads from HyperIndex's SQLite)
- Keep: config, logger, db, executionService, mempoolService, pass loop wiring

### `src/orchestrator/pass_loop.ts`

- `getPools()` reads from HyperIndex DB tables instead of `ctx.getPools()`
- State cache reads from `PoolState` entities instead of in-memory Map
- Keep: graph, cycles, pipeline, builder, execution logic

### `src/services/watcher/` (remove)

- Entire directory replaced by HyperIndex event handlers
- No more poll loop, filter, reorg detection, manual decoding

### `src/services/discovery/` (remove)

- Entire directory replaced by `contractRegister` handlers
- No more allPairs iteration, PoolCreated queries, curve RPC discovery

### `src/services/hydration/` (remove)

- Entire directory replaced by event-driven state updates
- No more warmup, sweep, manual RPC refresh

### `src/infra/db/pools.ts`

- Add `getPoolStateFromHyperIndex()` — reads from PoolState entities
- Keep existing pool schema for backwards compatibility
- Token metadata table for decimals/symbol

## State Flow

```
Event received (HyperSync)
  │
  ▼
contractRegister → PoolMeta entity created (factory events)
  │
  ▼
onEvent handler → PoolState entity updated (Sync/Swap events)
  │
  ▼
createEffect → TokenMeta entity created (one-time RPC)
  │
  ▼
Pass loop reads PoolMeta + PoolState from DB
  │
  ▼
buildGraph → enumerateCycles → evaluatePipeline → execute
```

## Data Sharing

HyperIndex manages its own SQLite database in `hyperindex/.hyperindex/db.sqlite`. The bot's pass loop reads from this database directly.

HyperIndex flushes entity writes to SQLite after each batch of events (typically every block). The pass loop queries the SQLite tables:

```typescript
// Pool discovery
const pools = db.prepare("SELECT id, protocol, tokens FROM pool_meta").all();

// Per-protocol state queries
const v2State = db.prepare("SELECT * FROM v2_pool_state WHERE address = ?").get(addr);
const v3State = db.prepare("SELECT * FROM v3_pool_state WHERE address = ?").get(addr);
const curveState = db.prepare("SELECT * FROM curve_pool_state WHERE address = ?").get(addr);
const balancerState = db.prepare("SELECT * FROM balancer_pool_state WHERE address = ?").get(addr);
```

No in-memory state cache needed — the DB is the single source of truth.

### Fallback RPC Refresh

During the transition period, a lightweight fallback runs alongside HyperIndex:

```typescript
// If HyperIndex DB has no state for a pool, fall back to one-time RPC
// This handles edge cases where events haven't been indexed yet
async function getPoolState(addr: string) {
  return db.prepare("SELECT * FROM v2_pool_state WHERE id = ?").get(addr)
    ?? await rpcFallback(addr);
}
```

This fallback can be removed once HyperIndex is proven stable.

## Reorg Handling

HyperIndex automatically handles chain reorgs. When a reorg occurs:
- Entities written by affected blocks are rolled back
- Event handlers re-run for the new canonical chain
- The pass loop always reads the canonical state

No manual `rollback_guard` table or `checkReorg()` needed.

## Bun Migration

- HyperIndex CLI runs natively on Bun
- All existing bot code uses Node.js-compatible APIs
- `node:sqlite` → Bun's built-in SQLite
- Package.json: swap `node` for `bun` in scripts
- `.bunrc` or `bunfig.toml` for TypeScript config

## Project Structure

The HyperIndex project lives inside the existing repo as `hyperindex/`:

```
arb-t/
├── hyperindex/
│   ├── config.yaml
│   ├── schema.graphql
│   ├── abis/              # ABI JSON files for all contracts
│   └── src/
│       ├── handlers/
│       │   ├── v2_factory.ts
│       │   ├── v2_pool.ts
│       │   ├── v3_factory.ts
│       │   ├── v3_pool.ts
│       │   ├── curve_factory.ts
│       │   └── curve_pool.ts
│       └── effects/
│           └── token_decimals.ts
├── src/                    # Existing bot code (strategy, execution, CLI)
│   └── orchestrator/
│       ├── boot.ts         # Modified: reads from HyperIndex DB
│       └── pass_loop.ts    # Modified: reads from HyperIndex DB
└── docs/
    └── superpowers/specs/
```

HyperIndex runs as a child process managed by the bot's `main.ts`. On boot:
1. Start HyperIndex process (`envio run`)
2. Wait for initial sync
3. Start pass loop (reads from HyperIndex's SQLite)

On shutdown:
1. Stop pass loop
2. Stop HyperIndex process

Alternatively, HyperIndex runs independently (systemd, tmux, or similar) and the bot connects to its DB — this is more robust for production since HyperIndex can catch up after restarts independently.

## Rollout Plan

1. Create `hyperindex/` project structure (config.yaml, schema.graphql)
2. Write factory handlers for V2 (8 factories)
3. Write factory handlers for V3 (4 factories)
4. Write event handlers for Sync/Swap
5. Create effects for token decimals, Curve A/fee, Balancer poolId
6. Modify pass loop to read from HyperIndex DB
7. Remove old discovery/watcher/hydration services
8. Switch to Bun runtime
9. Run full test suite
10. End-to-end test with real RPC

## Risk Mitigation

- **DB schema collision**: Prefix HyperIndex entities (`hi_` namespace) or use separate DB file initially, then migrate
- **Handler bugs**: Handlers can be tested individually with HyperIndex test runner
- **Missed events**: Both HyperIndex and fallback RPC refresh can run in parallel during transition
- **Bun compatibility**: Run existing test suite under Bun first, fix any issues before migration
