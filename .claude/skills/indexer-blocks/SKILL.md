---
name: indexer-blocks
description: >-
  Use when processing every block (or every Nth block) for time-series data,
  periodic snapshots, or block-level aggregations. indexer.onBlock API, where
  filter with block-number range and stride, preload behavior, and performance
  patterns.
metadata:
  managed-by: envio
---

# Block Handlers

Process every block (or every Nth block) using `indexer.onBlock`. No contract
address or `config.yaml` entry needed.

## Handler

Branch by `chain.id` with a `switch` so the type system flags any
unconfigured chain via the `default: never` exhaustiveness check:

```ts
import { indexer } from "envio";

indexer.onBlock(
  {
    name: "BlockTracker",
    where: ({ chain }) => {
      switch (chain.id) {
        case 1:
          return { block: { number: { _gte: 18000000, _every: 100 } } };
        case 8453:
          return { block: { number: { _every: 50 } } };
        default: {
          // Exhaustiveness check: TypeScript errors here if a new chain ID
          // is added to config.yaml but not handled above.
          const _exhaustive: never = chain.id;
          return false;
        }
      }
    },
  },
  async ({ block, context }) => {
    context.BlockSnapshot.set({
      id: `${block.number}`,
      blockNumber: BigInt(block.number),
    });
  },
);
```

## Preload Optimization (V3)

**Block handlers always run with preload optimization enabled.**

Your handler is invoked **twice** per matching block:

1. **Preload pass** (`context.isPreload === true`) — parallel, for scheduling `context.effect(...)` calls. Entity writes are ignored by the framework.
2. **Execution pass** (`context.isPreload === false`) — sequential, where your `.set()` / `.deleteUnsafe()` calls take effect.

Always guard work that should only happen once:

```ts
async ({ block, context }) => {
  if (context.isPreload) return;

  // expensive work, RPC via effects, or writes here
  context.MySnapshot.set({ id: `${block.number}`, ... });
}
```

See:

- `indexer-handlers` for the full `context` API (including `isPreload`, `chain`, `effect`, `log`)
- `indexer-external-calls` when you need RPC, HTTP, or other I/O from a block handler

## Options

| Option  | Type                               | Required | Description                                                                                                                                                                                                                                                                      |
| ------- | ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`  | `string`                           | yes      | Handler name for logging, metrics, and debugging                                                                                                                                                                                                                                 |
| `where` | `({ chain }) => boolean \| filter` | no       | Evaluated once per configured chain at startup. Return `false` to disable for that chain, `true` or omit to run on every block, or `{ block: { number: { _gte?, _lte?, _every? } } }` to scope it. `_every` is relative to `_gte` (or 0): `(blockNumber - _gte) % _every === 0`. |

## Performance Recipes

### Historical vs Realtime with Different Strides

Speed up historical sync while keeping realtime responsive by registering two handlers:

```ts
const REALTIME_START = {
  1: 19_783_636,
  8453: 12_345_678,
} as const;

indexer.onBlock(
  {
    name: "HistoricalSnapshots",
    where: ({ chain }) => {
      const start = REALTIME_START[chain.id as keyof typeof REALTIME_START];
      if (!start) return false;
      return { block: { number: { _lte: start - 1, _every: 1000 } } };
    },
  },
  async ({ block, context }) => {
    if (context.isPreload) return;
    // coarse historical writes
  },
);

indexer.onBlock(
  {
    name: "RealtimeSnapshots",
    where: ({ chain }) => {
      const start = REALTIME_START[chain.id as keyof typeof REALTIME_START];
      if (!start) return false;
      return { block: { number: { _gte: start } } };
    },
  },
  async ({ block, context }) => {
    if (context.isPreload) return;
    // fine-grained realtime
  },
);
```

### Time-Based Intervals

Convert wall time to block stride:

```ts
// Every 60 minutes on a 12s blocktime chain
const seconds = 60 * 60;
const secPerBlock = 12;
const every = seconds / secPerBlock; // 300
```

Use different strides for historical vs realtime as shown above for best backfill performance.

### Preset / One-Shot Seeding

Run exactly once at a specific block (e.g. genesis or a known migration point) to populate initial reference data:

```ts
indexer.onBlock(
  {
    name: "SeedInitialData",
    where: ({ chain }) => {
      if (chain.id !== 1) return false;
      return { block: { number: { _gte: 0, _lte: 0 } } };
    },
  },
  async ({ block, context }) => {
    if (context.isPreload) return;

    // fetch once and seed entities
    const data = await fetchInitialData();
    data.forEach((d) => context.ReferenceData.set(d));
  },
);
```

## Data Available on the Block

Currently only `block.number` is provided directly.

For timestamps, hashes, gas used, etc., use the Effect API (`context.effect`) or the HyperSync client inside a guarded handler.

## Other ecosystems

- **Fuel**: same `indexer.onBlock` API; filter is keyed by `block.height` instead of `block.number`.
- **SVM**: use `indexer.onSlot`; filter shape is `{slot: {_gte?, _lte?, _every?}}` and the handler arg is `{slot: number, context}` (no `block` wrapper).

## Notes

- `indexer.onBlock` self-registers — no `config.yaml` entry or codegen step required.
- No events or contract addresses are needed.
- The `context` object is identical to event handlers (entity CRUD, `getWhere`, `effect`, `isPreload`, `chain`, `log`). See `indexer-handlers`.
- If `where` returns `false` for every configured chain, Envio logs a warning at registration.
- `_lte` and `_every` are only available in `onBlock` filters (not in `onEvent` / `onContractRegister`).
- For simple per-event `startBlock` semantics (no stride), prefer `indexer.onEvent` + `where` on the event (see `indexer-filters`).
- Use `context.chain.id` and `context.chain.isRealtime` inside the handler when needed.

## Deep Documentation

- Specific page: https://docs.envio.dev/docs/HyperIndex/block-handlers
- Full reference: https://docs.envio.dev/docs/HyperIndex-LLM/hyperindex-complete
