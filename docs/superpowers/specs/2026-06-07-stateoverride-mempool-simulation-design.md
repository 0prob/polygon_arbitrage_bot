# StateOverride-Based Mempool Simulation Design

## Overview

Replace the in-memory `PendingStateOverlay` with Geth's `stateOverride` via viem's `client.call({ stateOverride })`. When a pending swap is detected, simulate its effects by building a minimal `stateDiff` override, then execute the full arbitrage path (flashloan + all hops) in a single `eth_call` with overrides applied.

**Target Chain**: Polygon (Geth/Erigon) — supports `debug_traceCall` with `stateDiff` and `stateOverride`.

**Strategy**: Hybrid — try manual override construction first (from decoded swap + simulator math), fallback to `debug_traceCall` for `stateDiff` extraction.

## Architecture

### Components

| Component | File | Responsibility |
|-----------|------|----------------|
| `StateOverrideBuilder` | `src/services/mempool/state-override-builder.ts` | Protocol-aware manual override construction from decoded swap + current pool state |
| `TraceFallback` | `src/services/mempool/trace-fallback.ts` | `debug_traceCall` with `stateDiff` extraction when manual build fails |
| `MempoolSimulator` | `src/services/mempool/simulator.ts` | Orchestrates: decode → build override → `client.call` with override |
| `PendingOverrideStore` | `src/services/mempool/pending-override.ts` | Manages active override with TTL (newHead + 200ms) and multi-tx merging |

### Data Flow

```
PendingTx → MempoolService.decodeSwapCalldata() → DecodedSwap
    ↓
StateOverrideBuilder.build(DecodedSwap, currentPoolState) → StateOverride | null
    ↓ (if null)
TraceFallback.trace(pendingTxHash) → StateOverride
    ↓
PendingOverrideStore.update(override) → merges with existing (sequential compose)
    ↓
PipelineOptions.stateOverride = store.get() → evaluatePipeline uses client.call({ stateOverride })
    ↓
Dry-run uses same override for mempool-aware validation
    ↓
newHead event → PendingOverrideStore.clear()
```

## Type Definitions

```typescript
// src/core/types/state-override.ts
export interface StateOverride {
  [address: `0x${string}`]: {
    stateDiff?: Record<string, string>;  // slot (hex) -> value (hex)
    code?: `0x${string}`;
    balance?: string;
    nonce?: string;
  };
}

export interface ProtocolStateDelta {
  poolAddress: `0x${string}`;
  protocol: "V2" | "V3" | "BALANCER" | "CURVE" | "DODO" | "WOOFI";
  storageChanges: Record<string, bigint>;  // slot -> new value
}

export interface PendingTxSimulation {
  txHash: string;
  stateOverride: StateOverride;
  affectedPools: string[];
  timestamp: number;
}
```

## Manual Override Construction (Per Protocol)

Uses existing simulator math (`simulateV2Swap`, `simulateV3Swap`, etc.) to compute post-swap state, then maps to correct storage slots.

| Protocol | Storage Slots | Computation |
|----------|---------------|-------------|
| V2 | `reserve0` (slot 8), `reserve1` (slot 9) | `newReserve = oldReserve ± amountIn/Out` via `simulateV2Swap` |
| V3 | `slot0` (slot 0: sqrtPriceX96\|tick), `liquidity` (slot 1) | Compute new sqrtPriceX96 from `simulateV3Swap` |
| Balancer | Vault `poolId` → `balances` mapping (dynamic slots) | Read current balances, apply swap delta via `simulateBalancerSwap` |
| Curve | `balances` array (pool-specific slots) | Apply `exchange` delta via `simulateCurveSwap` |
| DODO | `baseReserve`, `quoteReserve` (known slots) | PMM formula via `simulateDodoSwap` |
| Woofi | `price`, `baseAmount`, `quoteAmount` | Update synthetic price + reserves via `simulateWoofiSwap` |

**Viem `client.call` with override:**
```typescript
const result = await client.call({
  account: fromAddress,
  to: executorAddress,
  data: arbCalldata,
  value: 0n,
  stateOverride: builtOverride,
  blockTag: "pending",
});
```

## Multi-Tx Merging

- **Same pool**: Compose sequentially — later tx overrides earlier (mempool order by timestamp)
- **Different pools**: Combine into single override object (merge address keys)
- **TTL**: Clear on `newHead` WebSocket event + 200ms time-based safety net

## Integration Points

1. **MempoolService** (`src/services/mempool/service.ts`):
   - On `large_swap` signal → decode → `PendingOverrideStore.update(override)`
   - Remove `PendingStateOverlay` dependency entirely
   - Clear on `newHead` via existing WebSocket handler

2. **evaluatePipeline** (`src/pipeline/pipeline.ts`):
   - Add `stateOverride?: StateOverride` to `PipelineOptions`
   - Pass to final `simulateRoute` call (full simulation with impact check)
   - Use in `client.call` for dry-run validation

3. **Dry-run** (`src/services/execution/dryrun.ts`):
   - Accept `stateOverride` in `dryRun()` call
   - Use `client.call({ stateOverride })` instead of plain `call`

4. **PassLoop** (`src/orchestrator/pass_loop.ts`):
   - Wire `PendingOverrideStore` into `RuntimeContext`
   - Clear on `newHead` event (already exists)

## Error Handling

- Manual build fails → `TraceFallback.debug_traceCall({ tracer: "stateDiff" })`
- Trace fails → log warning, skip mempool simulation for this pass
- Override >100 slots → truncate to affected pools only (keep largest swaps)

## Testing Strategy

- **Unit**: `StateOverrideBuilder` per protocol with known pool states (compare against simulator)
- **Integration**: Mock RPC with `debug_traceCall` returning stateDiff
- **E2E**: Replay real mempool txs against forked state (Anvil/Foundry)

## Files to Create/Modify

### New Files
- `src/core/types/state-override.ts` — Type definitions
- `src/services/mempool/state-override-builder.ts` — Manual override construction
- `src/services/mempool/trace-fallback.ts` — debug_traceCall fallback
- `src/services/mempool/pending-override.ts` — Override store with TTL/merge
- `src/services/mempool/simulator.ts` — High-level mempool simulation orchestration

### Modified Files
- `src/services/mempool/service.ts` — Remove `PendingStateOverlay`, use `PendingOverrideStore`
- `src/pipeline/pipeline.ts` — Add `stateOverride` to `PipelineOptions`, pass to simulation
- `src/pipeline/simulator.ts` — Accept `stateOverride` in `simulateRoute`/`simulateRouteMinimal`
- `src/services/execution/dryrun.ts` — Accept `stateOverride` in `dryRun()`
- `src/orchestrator/boot.ts` — Wire `PendingOverrideStore` into `RuntimeContext`
- `src/orchestrator/pass_loop.ts` — Pass override to pipeline, clear on newHead

## Rollout Plan

1. Implement types + builder + fallback + store (independent, testable)
2. Integrate into MempoolService (replace overlay)
3. Wire into pipeline + dry-run
4. Test with forked Polygon mainnet
5. Remove `InMemoryPendingStateOverlay` and `PendingStateOverlay` interface