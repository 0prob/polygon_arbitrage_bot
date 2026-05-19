# Uniswap V4 Arbitrage Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Uniswap V4 pool indexing, swap simulation, and on-chain execution to the Polygon arbitrage bot.

**Architecture:** V4 uses a single PoolManager contract with bytes32 pool IDs. The hyperindex layer adds V4PoolState entities (schema/config/handler). The bot layer reuses V3 swap math for simulation and adds a `encodeV4Hop()` calldata encoder that wraps each hop in `PoolManager.lock()` → `lockAcquired()` callbacks. The ArbExecutor contract gets a `lockAcquired()` callback and `poolManager` address for V4 settlement via `settle()`/`take()`.

**Tech Stack:** Envio HyperIndex, TypeScript, Viem, Solidity (Foundry)

---

### Task 1: Fetch V4 PoolManager ABI

**Files:**
- Create: `hyperindex/abis/uniswap_v4_pool_manager.json`

- [ ] **Step 1: Fetch PoolManager ABI from Polygonscan**

Run: `curl https://api.polygonscan.com/api?module=contract&action=getabi&address=0x67366782805870060151383f4bbff9dab53e5cd6 -o /home/x/arb/t/hyperindex/abis/uniswap_v4_pool_manager.json 2>/dev/null; python3 -c "import json; d=json.load(open('/home/x/arb/t/hyperindex/abis/uniswap_v4_pool_manager.json')); print('result' in d and d['result'].startswith('[') or 'FALLBACK')"`

If Polygonscan fails, use the Uniswap V4 npm package ABI instead. The ABI must include at minimum:
- `event Initialize` with params: `id`, `currency0`, `currency1`, `fee`, `tickSpacing`, `hooks`, `sqrtPriceX96`, `tick`
- `event Swap` with params: `id`, `sender`, `amount0`, `amount1`, `sqrtPriceX96`, `liquidity`, `tick`, `fee`
- `function lock(bytes)` → `bytes`
- `function swap((address,address,uint24,int24,address),bool,int128,uint160,bytes)` → `(int256,int256)`
- `function settle(address)` → `()`
- `function take(address,address,uint256)` → `()`

- [ ] **Step 2: Verify ABI has required events**

```bash
cat /home/x/arb/t/hyperindex/abis/uniswap_v4_pool_manager.json | python3 -c "
import json,sys
abi = json.load(sys.stdin)
events = {e['name'] for e in abi if e.get('type')=='event'}
funcs = {f['name'] for f in abi if f.get('type')=='function'}
required_events = {'Initialize','Swap'}
required_funcs = {'lock','swap','settle','take'}
missing_events = required_events - events
missing_funcs = required_funcs - funcs
if missing_events or missing_funcs:
    print(f'MISSING: events={missing_events}, funcs={missing_funcs}')
    sys.exit(1)
print('ABI OK')
"
```

Expected: `ABI OK`

- [ ] **Step 3: Commit**

```bash
git add hyperindex/abis/uniswap_v4_pool_manager.json
git commit -m "feat(hyperindex): add V4 PoolManager ABI"
```

---

### Task 2: Add V4PoolState Schema + Codegen

**Files:**
- Modify: `hyperindex/schema.graphql`
- Modify: `hyperindex/envio-env.d.ts` (no change needed, already references .envio/types.d.ts)

- [ ] **Step 1: Add V4PoolState entity to schema.graphql**

Append to `hyperindex/schema.graphql`:

```graphql
type V4PoolState {
  id: ID!
  address: String!
  lastUpdatedBlock: Int!
  sqrtPriceX96: BigInt!
  liquidity: BigInt!
  tick: Int!
  fee: BigInt!
  tickSpacing: Int!
  hooks: String!
}
```

- [ ] **Step 2: Run envio codegen**

```bash
cd /home/x/arb/t/hyperindex && bunx envio codegen
```

Expected: No output (or deprecation warnings only)

- [ ] **Step 3: Verify V4PoolState types exist**

```bash
grep -q 'V4PoolState' /home/x/arb/t/hyperindex/.envio/types.d.ts && echo "OK" || echo "MISSING"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add hyperindex/schema.graphql hyperindex/.envio/
git commit -m "feat(hyperindex): add V4PoolState schema entity"
```

---

### Task 3: Add PoolManager to Config

**Files:**
- Modify: `hyperindex/config.yaml`

- [ ] **Step 1: Add PoolManager contract entry**

Add after the Curve Registry section in `hyperindex/config.yaml`:

```yaml
      # Uniswap V4 PoolManager
      - name: PoolManager
        address: "0x67366782805870060151383f4bbff9dab53e5cd6"
        abi_file_path: abis/uniswap_v4_pool_manager.json
        handler: src/handlers_mjs/handlers/v4.js
        events:
          - event: Initialize
          - event: Swap
```

- [ ] **Step 2: Run envio codegen to update types**

```bash
cd /home/x/arb/t/hyperindex && bunx envio codegen
```

- [ ] **Step 3: Verify PoolManager appears in generated types**

```bash
grep -q 'PoolManager' /home/x/arb/t/hyperindex/.envio/types.d.ts && echo "OK" || echo "MISSING"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add hyperindex/config.yaml hyperindex/.envio/
git commit -m "feat(hyperindex): add PoolManager contract to config"
```

---

### Task 4: Write V4 HyperIndex Handler

**Files:**
- Create: `hyperindex/src/handlers_ts/v4.ts`

- [ ] **Step 1: Create the V4 handler file**

Write `hyperindex/src/handlers_ts/v4.ts`:

```typescript
import { indexer } from "envio";

indexer.onEvent(
  { contract: "PoolManager", event: "Initialize" },
  async ({ event, context }) => {
    const poolId = event.params.id.toLowerCase();
    const currency0 = event.params.currency0.toLowerCase();
    const currency1 = event.params.currency1.toLowerCase();

    context.PoolMeta.set({
      id: poolId,
      address: poolId,
      protocol: "uniswap_v4",
      tokens: [currency0, currency1],
      token0: currency0,
      token1: currency1,
      createdBlock: event.block.number,
    });

    context.V4PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: event.block.number,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: 0n,
      tick: event.params.tick,
      fee: BigInt(event.params.fee),
      tickSpacing: event.params.tickSpacing,
      hooks: event.params.hooks.toLowerCase(),
    });
  },
);

indexer.onEvent(
  { contract: "PoolManager", event: "Swap" },
  async ({ event, context }) => {
    const poolId = event.params.id.toLowerCase();

    context.V4PoolState.set({
      id: poolId,
      address: poolId,
      lastUpdatedBlock: event.block.number,
      sqrtPriceX96: event.params.sqrtPriceX96,
      liquidity: event.params.liquidity,
      tick: event.params.tick,
      fee: BigInt(event.params.fee),
      tickSpacing: 0,
      hooks: "",
    });
  },
);
```

Note: `tickSpacing` and `hooks` are set to defaults in the Swap handler because they don't change after initialization and are only available in the Initialize event. They remain in the entity from the initial creation.

- [ ] **Step 2: Run compile to verify**

```bash
cd /home/x/arb/t/hyperindex && npx tsc --outDir src/handlers_mjs --skipLibCheck --moduleResolution bundler 2>/dev/null; true
```

Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add hyperindex/src/handlers_ts/v4.ts hyperindex/src/handlers_mjs/
git commit -m "feat(hyperindex): add V4 Initialize and Swap handlers"
```

---

### Task 5: Add V4 Protocol Support to Bot Types and Reading

**Files:**
- Modify: `src/core/types/protocol.ts`
- Modify: `src/infra/db/hyperindex_reader.ts`

- [ ] **Step 1: Add UNISWAP_V4 to V3_FAMILY_KEYS**

In `src/core/types/protocol.ts`, add `"UNISWAP_V4"` to `V3_FAMILY_KEYS`:

```typescript
export const V3_FAMILY_KEYS = new Set(["UNISWAP_V3", "SUSHISWAP_V3", "QUICKSWAP_V3", "KYBERSWAP_ELASTIC", "UNISWAP_V4"]);
```

This makes `protocolFamily("uniswap_v4")` return `"V3"`, which is correct since V4 uses the same concentrated liquidity math.

- [ ] **Step 2: Add V4 pool state reader and update buildStateCacheFromHyperIndex**

In `src/infra/db/hyperindex_reader.ts`, add a V4PoolState row type and update `readHyperIndexState` to also query V4:

```typescript
export type V4PoolStateRow = {
  id: string;
  address: string;
  lastUpdatedBlock: number;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  fee: string;
  tickSpacing: number;
  hooks: string;
};
```

In `readHyperIndexState()`, add V4 query after the V3 block (before the Curve block):

```typescript
  const v4 = hiDb.prepare("SELECT sqrtPriceX96, liquidity, tick FROM v4_pool_state WHERE id = ?").get(addr) as
    { sqrtPriceX96: string; liquidity: string; tick: number } | undefined;
  if (v4) return { sqrtPriceX96: BigInt(v4.sqrtPriceX96), liquidity: BigInt(v4.liquidity), tick: v4.tick };
```

The V4 state shape (sqrtPriceX96, liquidity, tick) is identical to V3, so the returned record works with `simulateV3Swap()` without modification.

- [ ] **Step 3: Compile check**

```bash
cd /home/x/arb/t && npx tsc --noEmit 2>&1 | head -20
```

Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/core/types/protocol.ts src/infra/db/hyperindex_reader.ts
git commit -m "feat: add V4 protocol support and state reader"
```

---

### Task 6: Add V4 to Graph and Simulator

**Files:**
- Modify: `src/services/strategy/graph.ts`
- Modify: `src/services/strategy/simulator.ts`

- [ ] **Step 1: Confirm graph.ts needs no changes**

`src/services/strategy/graph.ts` builds edges using `pool.protocol` as a string — it's protocol-agnostic. The V4 handler sets `protocol: "uniswap_v4"` on `PoolMeta`, and the graph builder just passes it through. Run a grep to verify:

```bash
grep -n 'protocol\|pool.protocol' src/services/strategy/graph.ts
```

Expected: Protocol strings flow through without hardcoded checks on specific values.

- [ ] **Step 2: Route V4 to V3 swap math in simulator.ts**

In `src/services/strategy/simulator.ts`, line 54, add `"UNISWAP_V4"` to the V3 detection:

```typescript
  if (u.includes("V3") || u === "KYBERSWAP_ELASTIC" || u === "UNISWAP_V4") return "V3";
```

This makes `normalizeProtocol("uniswap_v4")` return `"V3"`, routing V4 hops to `simulateV3Swap()`.

- [ ] **Step 3: Compile and verify**

```bash
cd /home/x/arb/t && npx tsc --noEmit 2>&1 | head -20
```

Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/services/strategy/graph.ts src/services/strategy/simulator.ts
git commit -m "feat: add V4 to graph builder and swap simulator"
```

---

### Task 7: Add V4 Calldata Encoding

**Files:**
- Modify: `src/services/execution/calldata.ts`

- [ ] **Step 1: Add V4 ABI definitions and PoolKey encoder**

In `src/services/execution/calldata.ts`, add:

```typescript
const POOL_MANAGER_LOCK_ABI = [
  {
    name: "lock",
    type: "function",
    inputs: [
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "result", type: "bytes" }],
    stateMutability: "payable",
  },
];

const POOL_MANAGER_SWAP_ABI = [
  {
    name: "swap",
    type: "function",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountSpecified", type: "int128" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [
      { name: "delta0", type: "int256" },
      { name: "delta1", type: "int256" },
    ],
    stateMutability: "nonpayable",
  },
];
```

- [ ] **Step 2: Add `encodeV4Hop()` function**

Add before `encodeRoute()`:

```typescript
const POOL_MANAGER_ADDRESS = "0x67366782805870060151383f4bbff9dab53e5cd6";

export function encodeV4Hop(hop: CalldataHop, executor: string): ExecutorCall[] {
  const poolManager = getAddress(POOL_MANAGER_ADDRESS);
  const exec = getAddress(executor);
  const tokenIn = asAddress(hop.tokenIn);
  const tokenOut = asAddress(hop.tokenOut);
  const amountIn = normalizePositiveUint(hop.amountIn, "encodeV4Hop amountIn");
  const state = (hop.stateRef ?? {}) as Record<string, unknown>;
  const fee = normalizeUint(state.fee ?? 0, "encodeV4Hop fee");
  const tickSpacing = Number(state.tickSpacing ?? 0);
  const hooks = getAddress(String(state.hooks ?? ZERO_ADDRESS));

  const zeroForOne = Boolean(hop.zeroForOne);
  const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  const poolKey = {
    currency0: zeroForOne ? tokenIn : tokenOut,
    currency1: zeroForOne ? tokenOut : tokenIn,
    fee: Number(fee),
    tickSpacing,
    hooks,
  };

  const lockData = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountSpecified", type: "int128" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    [poolKey, zeroForOne, amountIn, sqrtPriceLimitX96],
  );

  return [
    encodeDynamicApprovalCall(exec, tokenIn, poolManager, amountIn),
    {
      target: poolManager,
      value: 0n,
      data: encodeFunctionData({
        abi: POOL_MANAGER_LOCK_ABI,
        functionName: "lock",
        args: [lockData],
      }),
    },
  ];
}
```

- [ ] **Step 3: Add V4 routing in `encodeRoute()`**

In the `encodeRoute()` function's protocol dispatch chain, add before the final `throw`:

```typescript
} else if (proto === "UNISWAP_V4") {
  calls.push(...encodeV4Hop(hop, executor));
}
```

- [ ] **Step 4: Compile check**

```bash
cd /home/x/arb/t && npx tsc --noEmit 2>&1 | head -20
```

Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/services/execution/calldata.ts
git commit -m "feat: add V4 swap calldata encoder"
```

---

### Task 8: Update ArbExecutor Contract for V4

**Files:**
- Modify: `sol/src/ArbExecutor.sol`

- [ ] **Step 1: Add PoolKey struct and IPoolManager interface**

In the interface section of `ArbExecutor.sol`, add:

```solidity
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IPoolManager {
    function swap(PoolKey calldata key, bool zeroForOne, int128 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata hookData) external returns (int256 delta0, int256 delta1);
    function settle(address currency) external payable;
    function take(address currency, address to, uint256 amount) external;
    function lock(bytes calldata data) external returns (bytes memory result);
}
```

- [ ] **Step 2: Add state variable and protocol constant**

Add to existing constants and state:

```solidity
uint8 private constant PROTOCOL_UNISWAP_V4 = 5;
```

Add to state section (after existing immutables):

```solidity
address public immutable poolManager;
```

- [ ] **Step 3: Add `lockAcquired()` callback**

Add before `_handlePoolSwapCallback`:

```solidity
function lockAcquired(bytes calldata data) external returns (bytes memory) {
    if (msg.sender != poolManager) revert CallbackOnly();
    if (_phase != PHASE_CALLBACK) revert InvalidFlashLoanContext();

    (PoolKey memory key, bool zeroForOne, int128 amountSpecified, uint160 sqrtPriceLimitX96) =
        abi.decode(data, (PoolKey, bool, int128, uint160));

    (int256 delta0, int256 delta1) = IPoolManager(poolManager).swap(
        key, zeroForOne, amountSpecified, sqrtPriceLimitX96, ""
    );

    if (delta0 > 0) IPoolManager(poolManager).settle(key.currency0);
    if (delta1 > 0) IPoolManager(poolManager).settle(key.currency1);
    if (delta0 < 0) IPoolManager(poolManager).take(key.currency0, address(this), uint256(-delta0));
    if (delta1 < 0) IPoolManager(poolManager).take(key.currency1, address(this), uint256(-delta1));

    return "";
}
```

- [ ] **Step 4: Add `poolManager` to constructor**

Update constructor to accept `address poolManager_` and validate:

```solidity
constructor(
    address owner_,
    address balancerVault_,
    address uniswapV3Factory_,
    address sushiV3Factory_,
    address quickswapV3Factory_,
    address kyberElasticFactory_,
    address aavePool_,
    address poolManager_   // <-- new parameter
) {
    if (... || poolManager_ == address(0)) revert ZeroAddress();
    ...
    poolManager = poolManager_;
}
```

- [ ] **Step 5: Compile contract**

```bash
cd /home/x/arb/t/sol && forge build 2>&1 | tail -5
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add sol/src/ArbExecutor.sol
git commit -m "feat(contract): add V4 PoolManager swap support via lockAcquired callback"
```

---

### Task 9: End-to-End Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Verify hyperindex compile**

```bash
cd /home/x/arb/t && pnpm hi:compile
```

Expected: No TypeScript errors, exit code 0

- [ ] **Step 2: Verify root project typecheck**

```bash
cd /home/x/arb/t && npx tsc --noEmit 2>&1 | head -20
```

Expected: No type errors

- [ ] **Step 3: Verify contract compiles**

```bash
cd /home/x/arb/t/sol && forge build 2>&1 | tail -5
```

Expected: No errors

- [ ] **Step 4: Run existing tests**

```bash
cd /home/x/arb/t && npx vitest run 2>&1 | tail -10
```

Expected: All existing tests pass
