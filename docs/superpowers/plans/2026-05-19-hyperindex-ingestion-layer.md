# HyperIndex Ingestion Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace RPC-heavy discovery/watcher/hydration with HyperIndex event-driven ingestion. Pool state updates via Sync/Swap events pushed through HyperSync instead of RPC polling. Strategy engine reads from HyperIndex SQLite DB.

**Architecture:** HyperIndex project in `hyperindex/` with config.yaml, schema.graphql, and event handlers. contractRegister auto-discovers pools from factory events. onEvent handlers capture state from Sync/Swap (wildcard). createEffect handles remaining RPC (decimals, curve A/fee, balancer poolId) with auto-dedup + caching. Strategy engine in `src/` reads from shared SQLite DB — no in-memory state cache needed.

**Tech Stack:** Envio HyperIndex (`envio` CLI + framework), viem (ABI encoding), HyperSync (data transport), SQLite (shared DB), Bun (runtime)

---

## File Structure

```
hyperindex/
├── config.yaml                    # 4 V3 factories, 8 V2 factories, Curve, Balancer
├── schema.graphql                 # PoolMeta, V2PoolState, V3PoolState, etc.
├── package.json                   # envio + viem + typescript
│   tsconfig.json
├── abis/
│   ├── uniswap_v2_factory.json    # PairCreated event
│   ├── uniswap_v2_pool.json       # Sync event
│   ├── uniswap_v3_factory.json    # PoolCreated event
│   ├── uniswap_v3_pool.json       # Swap event
│   ├── curve_factory.json         # PoolAdded event
│   └── erc20.json                 # decimals()
├── src/
│   ├── handlers/
│   │   ├── v2_factory.ts          # contractRegister for PairCreated
│   │   ├── v2_pool.ts             # onEvent Sync → V2PoolState
│   │   ├── v3_factory.ts          # contractRegister for PoolCreated
│   │   ├── v3_pool.ts             # onEvent Swap → V3PoolState
│   │   ├── curve_factory.ts       # contractRegister for PoolAdded
│   │   └── curve_pool.ts          # onEvent for Curve state
│   └── effects/
│       ├── token_decimals.ts      # createEffect for decimals()
│       ├── curve_metadata.ts      # createEffect for A(), fee()
│       └── balancer_metadata.ts   # createEffect for getPoolTokens()
```

**Modified (in `src/`):**
- `src/orchestrator/boot.ts` — read pool meta + state from HyperIndex DB
- `src/orchestrator/pass_loop.ts` — read state cache from HyperIndex DB
- `src/cli/main.ts` — manage HyperIndex child process lifecycle
- `package.json` — add bun scripts, remove unused deps

**Removed:**
- `src/services/discovery/` (4 files)
- `src/services/watcher/` (6 files)
- `src/services/hydration/` (4 files)
- `src/infra/hypersync/client.ts` (replaced by HyperIndex)
- `src/infra/hypersync/query.ts` (replaced by HyperIndex)

---

### Task 1: Create HyperIndex project scaffolding

**Files:**
- Create: `hyperindex/package.json`
- Create: `hyperindex/tsconfig.json`
- Create: `hyperindex/.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "arb-bot-ingestion",
  "private": true,
  "scripts": {
    "codegen": "envio codegen",
    "dev": "envio dev",
    "run": "envio run"
  },
  "dependencies": {
    "envio": "latest",
    "viem": "^2.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./generated"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
generated/
.hyperindex/
```

- [ ] **Step 4: Install dependencies**

Run: `cd hyperindex && bun install`

Expected: `bun install` completes without errors, `node_modules/envio` exists

- [ ] **Step 5: Commit**

```bash
git add hyperindex/package.json hyperindex/tsconfig.json hyperindex/.gitignore
git commit -m "feat(hyperindex): project scaffolding"
```

---

### Task 2: Create ABI JSON files

**Files:**
- Create: `hyperindex/abis/uniswap_v2_factory.json`
- Create: `hyperindex/abis/uniswap_v2_pool.json`
- Create: `hyperindex/abis/uniswap_v3_factory.json`
- Create: `hyperindex/abis/uniswap_v3_pool.json`
- Create: `hyperindex/abis/curve_factory.json`
- Create: `hyperindex/abis/erc20.json`

- [ ] **Step 1: Write `abis/uniswap_v2_factory.json`**

```json
[
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "token0", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "token1", "type": "address" },
      { "indexed": false, "internalType": "address", "name": "pair", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "", "type": "uint256" }
    ],
    "name": "PairCreated",
    "type": "event"
  }
]
```

- [ ] **Step 2: Write `abis/uniswap_v2_pool.json`**

```json
[
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "sender", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "amount0In", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amount1In", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amount0Out", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "amount1Out", "type": "uint256" }
    ],
    "name": "Swap",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": false, "internalType": "uint256", "name": "reserve0", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "reserve1", "type": "uint256" }
    ],
    "name": "Sync",
    "type": "event"
  }
]
```

- [ ] **Step 3: Write `abis/uniswap_v3_factory.json`**

```json
[
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "token0", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "token1", "type": "address" },
      { "indexed": true, "internalType": "uint24", "name": "fee", "type": "uint24" },
      { "indexed": false, "internalType": "int24", "name": "tickSpacing", "type": "int24" },
      { "indexed": false, "internalType": "address", "name": "pool", "type": "address" }
    ],
    "name": "PoolCreated",
    "type": "event"
  }
]
```

- [ ] **Step 4: Write `abis/uniswap_v3_pool.json`**

```json
[
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "sender", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "recipient", "type": "address" },
      { "indexed": false, "internalType": "int256", "name": "amount0", "type": "int256" },
      { "indexed": false, "internalType": "int256", "name": "amount1", "type": "int256" },
      { "indexed": false, "internalType": "uint160", "name": "sqrtPriceX96", "type": "uint160" },
      { "indexed": false, "internalType": "uint128", "name": "liquidity", "type": "uint128" },
      { "indexed": false, "internalType": "int24", "name": "tick", "type": "int24" }
    ],
    "name": "Swap",
    "type": "event"
  }
]
```

- [ ] **Step 5: Write `abis/curve_factory.json`**

```json
[
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "pool", "type": "address" }
    ],
    "name": "PoolAdded",
    "type": "event"
  }
]
```

- [ ] **Step 6: Write `abis/erc20.json`**

```json
[
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "internalType": "uint8", "name": "", "type": "uint8" }],
    "stateMutability": "view",
    "type": "function"
  }
]
```

- [ ] **Step 7: Commit**

```bash
git add hyperindex/abis/
git commit -m "feat(hyperindex): ABI JSON files for all contracts"
```

---

### Task 3: Create config.yaml

**Files:**
- Create: `hyperindex/config.yaml`

This config defines all Polygon contracts, their ABIs, and which handlers to call.

- [ ] **Step 1: Write config.yaml**

```yaml
name: arb_bot_ingestion
networks:
  - id: 137
    startBlock: 0
    contracts:
      # V2 Factories (8)
      - name: QuickswapV2Factory
        address: "0x5757371414417b8c6caad45baef941abc7d3ab32"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: SushiswapV2Factory
        address: "0xc35dadb65012ec5796536bd9864ed8773abc74c4"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: UniswapV2Factory
        address: "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: DfynV2Factory
        address: "0xe7fb3e833efe5f9c441105eb65ef8b261266423b"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: ApeswapV2Factory
        address: "0xcf083be4164828f00cae704ec15a36d711491284"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: MeshswapV2Factory
        address: "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: JetswapV2Factory
        address: "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      - name: ComethswapV2Factory
        address: "0x800b052609c355ca8103e06f022aa30647ead60a"
        abi_file: abis/uniswap_v2_factory.json
        handler: src/handlers/v2_factory.ts
        events:
          - event: PairCreated
      # V2 Pools (wildcard — any address emitting these events)
      - name: UniswapV2Pool
        abi_file: abis/uniswap_v2_pool.json
        handler: src/handlers/v2_pool.ts
        wildcard: true
        events:
          - event: Swap
          - event: Sync
      # V3 Factories (4)
      - name: UniswapV3Factory
        address: "0x1f98431c8ad98523631ae4a59f267346ea31f984"
        abi_file: abis/uniswap_v3_factory.json
        handler: src/handlers/v3_factory.ts
        events:
          - event: PoolCreated
      - name: SushiswapV3Factory
        address: "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2"
        abi_file: abis/uniswap_v3_factory.json
        handler: src/handlers/v3_factory.ts
        events:
          - event: PoolCreated
      - name: QuickswapV3Factory
        address: "0x411b0facc3489691f28ad58c47006af5e3ab3a28"
        abi_file: abis/uniswap_v3_factory.json
        handler: src/handlers/v3_factory.ts
        events:
          - event: PoolCreated
      - name: KyberswapElasticFactory
        address: "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a"
        abi_file: abis/uniswap_v3_factory.json
        handler: src/handlers/v3_factory.ts
        events:
          - event: PoolCreated
      # V3 Pools (wildcard)
      - name: UniswapV3Pool
        abi_file: abis/uniswap_v3_pool.json
        handler: src/handlers/v3_pool.ts
        wildcard: true
        events:
          - event: Swap
      # Curve
      - name: CurveRegistry
        address: "0x296d2B5C23833A70D07c8fCBB97d846c1ff90DDD"
        abi_file: abis/curve_factory.json
        handler: src/handlers/curve_factory.ts
        events:
          - event: PoolAdded
      - name: CurvePool
        abi_file: abis/uniswap_v2_pool.json
        handler: src/handlers/curve_pool.ts
        wildcard: true
        events:
          - event: Sync
```

- [ ] **Step 2: Commit**

```bash
git add hyperindex/config.yaml
git commit -m "feat(hyperindex): contract config with all factories"
```

---

### Task 4: Create schema.graphql

**Files:**
- Create: `hyperindex/schema.graphql`

- [ ] **Step 1: Write schema.graphql**

```graphql
type PoolMeta {
  id: ID!
  address: String!
  protocol: String!
  tokens: [String!]!
  token0: String
  token1: String
  createdBlock: Int!
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
}

type TokenMeta {
  id: ID!
  address: String!
  decimals: Int
}

type BalancerPoolState {
  id: ID!
  address: String!
  lastUpdatedBlock: Int!
  poolId: String!
  balances: [BigInt!]!
}
```

- [ ] **Step 2: Run codegen**

Run: `cd hyperindex && bun run codegen`

Expected: `generated/` directory created with TypeScript types matching schema

- [ ] **Step 3: Commit**

```bash
git add hyperindex/schema.graphql
git commit -m "feat(hyperindex): GraphQL schema for pool state entities"
```

---

### Task 5: Write V2 factory handler (contractRegister)

**Files:**
- Create: `hyperindex/src/handlers/v2_factory.ts`

All 8 V2 factories use the same handler — the protocol label comes from the contract name in config.yaml.

- [ ] **Step 1: Write v2_factory.ts**

```typescript
import { indexer } from "envio";

const FACTORY_PROTOCOLS: Record<string, string> = {
  "0x5757371414417b8c6caad45baef941abc7d3ab32": "quickswap_v2",
  "0xc35dadb65012ec5796536bd9864ed8773abc74c4": "sushiswap_v2",
  "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c": "uniswap_v2",
  "0xe7fb3e833efe5f9c441105eb65ef8b261266423b": "dfyn_v2",
  "0xcf083be4164828f00cae704ec15a36d711491284": "apeswap_v2",
  "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d": "meshswap_v2",
  "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7": "jetswap_v2",
  "0x800b052609c355ca8103e06f022aa30647ead60a": "comethswap_v2",
};

async function handlePairCreated({ event, context }: any) {
  const factoryAddr = event.srcAddress.toLowerCase();
  const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "unknown_v2";
  context.chain.UniswapV2Pool.add(event.params.pair);
  context.PoolMeta.set({
    id: event.params.pair.toLowerCase(),
    address: event.params.pair.toLowerCase(),
    protocol,
    tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
    token0: event.params.token0.toLowerCase(),
    token1: event.params.token1.toLowerCase(),
    createdBlock: event.block.number,
  });
}

// One registration per factory name from config.yaml
indexer.contractRegister({ contract: "QuickswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "SushiswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "UniswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "DfynV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "ApeswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "MeshswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "JetswapV2Factory", event: "PairCreated" }, handlePairCreated);
indexer.contractRegister({ contract: "ComethswapV2Factory", event: "PairCreated" }, handlePairCreated);
```

Note: The `contractRegister` needs to be registered for each factory contract name. HyperIndex's `contractRegister` takes a `{ contract, event }` matcher that matches the contract name from config.yaml.

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/v2_factory.ts
git commit -m "feat(hyperindex): V2 factory handler with contractRegister"
```

---

### Task 6: Write V2 pool handler (Sync/Swap → state)

**Files:**
- Create: `hyperindex/src/handlers/v2_pool.ts`

- [ ] **Step 1: Write v2_pool.ts**

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Sync", wildcard: true },
  async ({ event, context }) => {
    context.V2PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      reserve0: event.params.reserve0,
      reserve1: event.params.reserve1,
    });
  },
);

indexer.onEvent(
  { contract: "UniswapV2Pool", event: "Swap", wildcard: true },
  async ({ event, context }) => {
    context.V2PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      reserve0: event.params.amount0Out > 0n
        ? event.params.reserve0
        : event.params.reserve0 - event.params.amount0In,
      reserve1: event.params.amount1Out > 0n
        ? event.params.reserve1
        : event.params.reserve1 - event.params.amount1In,
    });
  },
);
```

Note: V2 Swap events don't include reserves directly — they carry `amount0In/Out` and `amount1In/Out`. The reserves can be derived from the block's Sync event or by computing from swap amounts. The Sync handler is the authoritative source; Swap handler here is a best-effort fallback.

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/v2_pool.ts
git commit -m "feat(hyperindex): V2 pool Sync/Swap handlers"
```

---

### Task 7: Write V3 factory handler (contractRegister)

**Files:**
- Create: `hyperindex/src/handlers/v3_factory.ts`

- [ ] **Step 1: Write v3_factory.ts**

```typescript
import { indexer } from "envio";

const FACTORY_PROTOCOLS: Record<string, string> = {
  "0x1f98431c8ad98523631ae4a59f267346ea31f984": "uniswap_v3",
  "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2": "sushiswap_v3",
  "0x411b0facc3489691f28ad58c47006af5e3ab3a28": "quickswap_v3",
  "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a": "kyberswap_elastic",
};

async function handlePoolCreated({ event, context }: any) {
  const factoryAddr = event.srcAddress.toLowerCase();
  const protocol = FACTORY_PROTOCOLS[factoryAddr] ?? "unknown_v3";
  context.chain.UniswapV3Pool.add(event.params.pool);
  context.PoolMeta.set({
    id: event.params.pool.toLowerCase(),
    address: event.params.pool.toLowerCase(),
    protocol,
    tokens: [event.params.token0.toLowerCase(), event.params.token1.toLowerCase()],
    token0: event.params.token0.toLowerCase(),
    token1: event.params.token1.toLowerCase(),
    createdBlock: event.block.number,
  });
}

indexer.contractRegister({ contract: "UniswapV3Factory", event: "PoolCreated" }, handlePoolCreated);
indexer.contractRegister({ contract: "SushiswapV3Factory", event: "PoolCreated" }, handlePoolCreated);
indexer.contractRegister({ contract: "QuickswapV3Factory", event: "PoolCreated" }, handlePoolCreated);
indexer.contractRegister({ contract: "KyberswapElasticFactory", event: "PoolCreated" }, handlePoolCreated);
```

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/v3_factory.ts
git commit -m "feat(hyperindex): V3 factory handler with contractRegister"
```

---

### Task 8: Write V3 pool handler (Swap → state)

**Files:**
- Create: `hyperindex/src/handlers/v3_pool.ts`

- [ ] **Step 1: Write v3_pool.ts**

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "UniswapV3Pool", event: "Swap", wildcard: true },
  async ({ event, context }) => {
    context.V3PoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: event.params.tick,
    });
  },
);
```

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/v3_pool.ts
git commit -m "feat(hyperindex): V3 pool Swap handler"
```

---

### Task 9: Write Curve factory handler

**Files:**
- Create: `hyperindex/src/handlers/curve_factory.ts`

- [ ] **Step 1: Write curve_factory.ts**

```typescript
import { indexer } from "envio";

indexer.contractRegister(
  { contract: "CurveRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    context.chain.CurvePool.add(event.params.pool);
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
```

Note: Curve's `PoolAdded` event only emits the pool address. Token addresses must be fetched via `createEffect` (Task 11).

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/curve_factory.ts
git commit -m "feat(hyperindex): Curve factory handler"
```

---

### Task 10: Write Curve pool handler

**Files:**
- Create: `hyperindex/src/handlers/curve_pool.ts`

- [ ] **Step 1: Write curve_pool.ts**

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "CurvePool", event: "Sync", wildcard: true },
  async ({ event, context }) => {
    // Curve pools emit Sync with reserve0/reserve1
    context.CurvePoolState.set({
      id: event.srcAddress.toLowerCase(),
      address: event.srcAddress.toLowerCase(),
      lastUpdatedBlock: event.block.number,
      balances: [event.params.reserve0, event.params.reserve1],
      A: 0n,
      fee: 0n,
    });
  },
);
```

The `A` and `fee` fields are placeholders — they'll be populated by the createEffect handler (Task 11).

- [ ] **Step 2: Commit**

```bash
git add hyperindex/src/handlers/curve_pool.ts
git commit -m "feat(hyperindex): Curve pool Sync handler"
```

---

### Task 11: Write createEffect functions

**Files:**
- Create: `hyperindex/src/effects/token_decimals.ts`
- Create: `hyperindex/src/effects/curve_metadata.ts`
- Create: `hyperindex/src/effects/balancer_metadata.ts`

- [ ] **Step 1: Write token_decimals.ts**

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
    try {
      const decimals = await client.readContract({
        address: input.token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "decimals",
      });
      return { decimals: Number(decimals) };
    } catch {
      return { decimals: 18 };
    }
  },
);
```

- [ ] **Step 2: Write curve_metadata.ts**

```typescript
import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL!, { batch: true }),
});

const CURVE_ABI = parseAbi([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
]);

export const fetchCurveMetadata = createEffect(
  {
    name: "fetchCurveMetadata",
    input: { pool: S.string, nCoins: S.number },
    output: { A: S.bigint, fee: S.bigint, balances: S.array(S.bigint) },
    rateLimit: { calls: 10, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const [A, fee] = await Promise.all([
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "A" }),
        client.readContract({ address: pool, abi: CURVE_ABI, functionName: "fee" }),
      ]);
      const balances: bigint[] = [];
      for (let i = 0; i < input.nCoins; i++) {
        const bal = await client.readContract({ address: pool, abi: CURVE_ABI, functionName: "balances", args: [BigInt(i)] });
        balances.push(bal as bigint);
      }
      return { A: A as bigint, fee: fee as bigint, balances };
    } catch {
      return { A: 100n, fee: 0n, balances: [] };
    }
  },
);
```

- [ ] **Step 3: Write balancer_metadata.ts**

```typescript
import { createEffect, S } from "envio";
import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL!, { batch: true }),
});

const BALANCER_ABI = parseAbi([
  "function getPoolId() view returns (bytes32)",
]);

const VAULT_ABI = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[], uint256[], uint256)",
]);

export const fetchBalancerMetadata = createEffect(
  {
    name: "fetchBalancerMetadata",
    input: { pool: S.string },
    output: { poolId: S.string, balances: S.array(S.bigint), lastChangeBlock: S.bigint },
    rateLimit: { calls: 10, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    try {
      const pool = input.pool as `0x${string}`;
      const poolId = await client.readContract({ address: pool, abi: BALANCER_ABI, functionName: "getPoolId" });
      const vault = "0xba12222222228d8ba445958a75a0704d566bf2c8" as const;
      const [tokens, balances, lastChangeBlock] = await client.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "getPoolTokens",
        args: [poolId],
      });
      return {
        poolId: poolId as string,
        balances: (balances as bigint[]).map((b) => BigInt(b)),
        lastChangeBlock: BigInt(lastChangeBlock as bigint),
      };
    } catch {
      return { poolId: "", balances: [], lastChangeBlock: 0n };
    }
  },
);
```

- [ ] **Step 4: Commit**

```bash
git add hyperindex/src/effects/
git commit -m "feat(hyperindex): createEffect functions for RPC calls"
```

---

### Task 12: Integrate pass loop with HyperIndex DB

**Files:**
- Modify: `src/orchestrator/boot.ts`
- Modify: `src/orchestrator/pass_loop.ts`

The pass loop currently reads pool state from an in-memory `stateCache: Map<string, Record<string, unknown>>`. After this task, it reads from the HyperIndex SQLite database.

- [ ] **Step 1: Modify `boot.ts` to add HyperIndex DB reader**

Add a function that reads pool meta + state from HyperIndex's SQLite tables:

```typescript
// In boot.ts, add after the DB initialization:

interface HyperIndexPoolRow {
  id: string;
  address: string;
  protocol: string;
  tokens: string;
  token0: string;
  token1: string;
  createdBlock: number;
}

interface HyperIndexStateRow {
  id: string;
  address: string;
  lastUpdatedBlock: number;
}

function readHyperIndexState(hiDb: CompatDatabase, address: string): Record<string, unknown> | null {
  // Try each pool state table
  const v2 = hiDb.prepare("SELECT reserve0, reserve1 FROM v2_pool_state WHERE id = ?").get(address) as
    { reserve0: string; reserve1: string } | undefined;
  if (v2) return { reserve0: BigInt(v2.reserve0), reserve1: BigInt(v2.reserve1) };

  const v3 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick FROM v3_pool_state WHERE id = ?").get(address) as
    { sqrtPriceX96: string; liquidity: string; tick: number } | undefined;
  if (v3) return { sqrtPriceX96: BigInt(v3.sqrtPriceX96), liquidity: BigInt(v3.liquidity), tick: v3.tick };

  const curve = hiDb.prepare("SELECT balances, A, fee FROM curve_pool_state WHERE id = ?").get(address) as
    { balances: string; A: string; fee: string } | undefined;
  if (curve) return { balances: JSON.parse(curve.balances).map(BigInt), A: BigInt(curve.A), fee: BigInt(curve.fee) };

  return null;
}
```

Then modify `getPools` to also read from HyperIndex's `pool_meta` table:

```typescript
const getPools = (): PoolMeta[] => {
  const hiDbPath = path.join(config.paths.dataDir, "../hyperindex/.hyperindex/db.sqlite");
  let hiDb: CompatDatabase | null = null;
  try {
    hiDb = createDatabase(hiDbPath);
  } catch {
    // HyperIndex DB not available yet
  }

  const rows = db.prepare("SELECT address, protocol, tokens FROM pools WHERE status = 'active'").all() as Array<{
    address: string; protocol: string; tokens: string;
  }>;

  // Also read from HyperIndex pool_meta if available
  if (hiDb) {
    const hiRows = hiDb.prepare("SELECT id, protocol, tokens FROM pool_meta").all() as Array<{
      id: string; protocol: string; tokens: string;
    }>;
    const existing = new Set(rows.map(r => r.address));
    for (const r of hiRows) {
      if (!existing.has(r.id)) {
        rows.push({ address: r.id, protocol: r.protocol, tokens: r.tokens });
      }
    }
  }

  return rows.map((r) => {
    let tokens: string[];
    try { tokens = JSON.parse(r.tokens); } catch { tokens = []; }
    return {
      address: r.address as Address,
      protocol: r.protocol,
      token0: (tokens[0] ?? "") as Address,
      token1: (tokens[1] ?? "") as Address,
      tokens: tokens as Address[],
    };
  });
};
```

- [ ] **Step 2: Modify `pass_loop.ts` to read state from HyperIndex DB**

Replace `stateCache = ctx.watcherService.getStateCache()` with a DB-backed read:

```typescript
// At the top of pass_loop.ts or as a helper
function readStateFromHyperIndex(dbPath: string, addresses: string[]): Map<string, Record<string, unknown>> {
  const cache = new Map<string, Record<string, unknown>>();
  try {
    const hiDb = createDatabase(dbPath);
    for (const addr of addresses) {
      const state = readHyperIndexState(hiDb, addr);
      if (state) cache.set(addr, state);
    }
    hiDb.close();
  } catch {
    // HyperIndex DB not available
  }
  return cache;
}

// Then in runPassLoop:
const hiDbPath = path.join(ctx.config.paths.dataDir, "../hyperindex/.hyperindex/db.sqlite");
const stateCache = readStateFromHyperIndex(hiDbPath, pools.map(p => p.address));
const graph = buildGraph(pools, stateCache);
```

Remove the entire watcherService dependency — no more `ctx.watcherService.getStateCache()`.

- [ ] **Step 3: Remove watcher/discovery/hydration initialization from boot.ts**

```typescript
// Remove these lines:
// const discoveryService = new DiscoveryService(discoveryDeps);
// const watcherService = new WatcherService(db, stateCache, watcherRegistry, watcherRefreshFns, activity);
// const hydrationService = new HydrationService(logger, stateCache, fetchPoolState, getPools);
```

Remove the entire `watcherRefreshFns` object, `refreshV2PoolState`, `fetchPoolState`, `discoveryDeps`, etc.

- [ ] **Step 4: Run tests**

Run: `cd /home/x/arb/t && npx vitest run src/orchestrator/pass_loop.test.ts --reporter=verbose`

Expected: Tests pass (the test mocks the context, so it won't actually hit the HyperIndex DB)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/boot.ts src/orchestrator/pass_loop.ts
git commit -m "feat: integrate pass loop with HyperIndex SQLite DB"
```

---

### Task 13: Clean up old services

**Files:**
- Remove: `src/services/discovery/` (4 files)
- Remove: `src/services/watcher/` (6 files)
- Remove: `src/services/hydration/` (4 files)
- Remove: `src/infra/hypersync/client.ts`
- Remove: `src/infra/hypersync/query.ts`
- Modify: `src/cli/main.ts` — remove watcher/discovery/hydration lifecycle

- [ ] **Step 1: Delete removed files**

```bash
git rm -r src/services/discovery/
git rm -r src/services/watcher/
git rm -r src/services/hydration/
git rm src/infra/hypersync/client.ts
git rm src/infra/hypersync/query.ts
```

- [ ] **Step 2: Update main.ts lifecycle**

Remove imports and lifecycle calls for watcher, discovery, hydration services from `src/cli/main.ts`.

- [ ] **Step 3: Run full test suite**

Run: `cd /home/x/arb/t && npx vitest run --reporter=verbose`

Expected: 327+ tests pass (some discovery/watcher/hydration test files removed, their test counts gone)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove discovery/watcher/hydration services (replaced by HyperIndex)"
```

---

### Task 14: Switch to Bun runtime

**Files:**
- Modify: `package.json` — add bun scripts, update engines

- [ ] **Step 1: Update root package.json scripts**

```json
{
  "scripts": {
    "dev": "bun run src/cli/main.ts",
    "test": "bunx vitest run",
    "test:watch": "bunx vitest",
    "typecheck": "bunx tsc --noEmit",
    "lint": "bunx biome check src/",
    "hyperindex:codegen": "cd hyperindex && bun run codegen",
    "hyperindex:run": "cd hyperindex && bun run run"
  }
}
```

- [ ] **Step 2: Run full test suite under Bun**

Run: `cd /home/x/arb/t && bunx vitest run --reporter=verbose`

Expected: All tests pass. If any fail due to Bun compatibility, fix them.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: switch to Bun runtime"
```

---

### Task 15: End-to-end integration test

**Files:**
- Modify: `src/cli/main.ts` — manage HyperIndex child process

- [ ] **Step 1: Add HyperIndex lifecycle to main.ts**

```typescript
import { spawn, type ChildProcess } from "child_process";

let hiProcess: ChildProcess | null = null;

async function startHyperIndex(): Promise<void> {
  return new Promise((resolve, reject) => {
    hiProcess = spawn("bun", ["run", "run"], {
      cwd: path.join(__dirname, "../hyperindex"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, POLYGON_RPC_URL: config.rpc.polygonRpcUrls[0] },
    });
    hiProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString();
      logger.info({ msg }, "HyperIndex");
      if (msg.includes("indexing")) resolve();
    });
    hiProcess.on("error", reject);
    setTimeout(() => resolve(), 30_000); // fallback timeout
  });
}

async function stopHyperIndex(): Promise<void> {
  if (hiProcess) {
    hiProcess.kill();
    hiProcess = null;
  }
}
```

- [ ] **Step 2: Wire into boot sequence**

```typescript
// In main.ts boot sequence:
await startHyperIndex();
const ctx = await bootApplication(config, activity);
// ctx.getPools() now reads from HyperIndex DB
```

- [ ] **Step 3: Add .gitignore for HyperIndex generated files**

Add to root `.opencodeignore` or `.gitignore`:
```
hyperindex/.hyperindex/
hyperindex/generated/
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/main.ts
git commit -m "feat: add HyperIndex child process lifecycle"
```
