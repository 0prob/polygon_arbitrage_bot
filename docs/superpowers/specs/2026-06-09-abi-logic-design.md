# 2026-06-09 Unified Type-Safe ABI Logic Design

## Goal
Audit, debug, and optimize ABI logic across the workspace by centralizing ABI management and enforcing type safety using `viem` and `as const` declarations.

## Architecture

### 1. Centralized ABI Registry
Move all ABI definitions to `src/core/abis/`. This replaces the redundant definitions in `src/services/execution/calldata/abis.ts` and the JSON-based `src/core/utils/compiled-abis.ts`.

- `src/core/abis/common.ts`: Common ABIs like ERC20.
- `src/core/abis/executor.ts`: ArbExecutor function and error ABIs.
- `src/core/abis/protocols/`: Protocol-specific ABIs (Uniswap, Curve, etc.).
- `src/core/abis/registry.ts`: The unified registry that maps selectors to their definitions.

### 2. Improved `AbiRegistry`
The `AbiRegistry` will be refactored to:
- Use `as const` ABIs for compile-time type safety.
- Pre-compute function and error selectors.
- Handle overloaded functions/errors by storing an array of definitions per selector.
- Provide a unified `decodeRevert` and `decodeCall` utility.

### 3. Updated Compilation Script
`scripts/compile-abis.ts` will be updated to generate TypeScript files with `as const` declarations instead of a single JSON blob. It will still inject missing functions like `swap` for HyperIndex-derived ABIs.

### 4. Decoder Optimization
`src/services/mempool/decoder.ts` will be refactored to use the unified registry and `viem`'s `decodeFunctionData` instead of manual heuristic decoding where possible.

## Data Flow
1. `scripts/compile-abis.ts` runs at build time to generate `src/core/abis/compiled/`.
2. `src/core/abis/registry.ts` imports all compiled and manual ABIs to build the static registry.
3. Services (`MempoolService`, `ExecutionService`) and scripts (`decode-failing.ts`) use the registry for all encoding/decoding tasks.

## Error Handling
- The registry will handle collisions by prioritizing the most "specific" ABI or keeping all variants for decoding.
- `decodeRevert` will recursively attempt to decode nested errors (e.g., `ExternalCallFailed` wrapping an `ERC20InsufficientBalance`).

## Testing
- Unit tests for the registry to verify selector mapping.
- Integration tests with `mempool/decoder.test.ts`.
- Regression test using `data/failing-calldata.ndjson`.
