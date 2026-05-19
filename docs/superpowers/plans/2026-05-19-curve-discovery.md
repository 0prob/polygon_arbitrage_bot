# Curve Pool Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stubbed Curve pool discovery logic with actual on-chain queries via `viem`.

**Architecture:**
- Create `src/services/discovery/curve_discovery.ts` to contain the on-chain query logic for Curve factories.
- Update `src/orchestrator/boot.ts` to pass a robust `fetchCurvePools` implementation to `DiscoveryService`.
- Enhance `DiscoveryService` to provide progress updates via the TUI callback.

**Tech Stack:** TypeScript, Viem

---

### Task 1: Create Curve Discovery Logic

**Files:**
- Create: `src/services/discovery/curve_discovery.ts`
- Modify: `src/orchestrator/boot.ts`

- [ ] **Step 1: Implement `fetchCurvePools` in `curve_discovery.ts`**

```typescript
import { type PublicClient, getContract } from "viem";
import type { Address } from "../../core/types/common.ts";
import type { CurvePoolInfo } from "./curve_factory.ts";

// Curve Registry/Factory ABIs (simplified)
const FACTORY_ABI = [
  {
    "type": "function",
    "name": "pool_count",
    "inputs": [],
    "outputs": [{"type": "uint256"}]
  },
  {
    "type": "function",
    "name": "pool_list",
    "inputs": [{"type": "uint256"}],
    "outputs": [{"type": "address"}]
  },
  {
    "type": "function",
    "name": "get_coins",
    "inputs": [{"type": "address"}],
    "outputs": [{"type": "address[8]"}]
  }
] as const;

export async function fetchCurvePools(
  client: PublicClient,
  factoryAddress: Address
): Promise<CurvePoolInfo[]> {
  const factory = getContract({ address: factoryAddress, abi: FACTORY_ABI, client });
  const poolCount = Number(await factory.read.pool_count());
  const pools: CurvePoolInfo[] = [];

  for (let i = 0; i < poolCount; i++) {
    const poolAddress = await factory.read.pool_list([BigInt(i)]);
    const coins = (await factory.read.get_coins([poolAddress])).filter(c => c !== "0x0000000000000000000000000000000000000000");
    pools.push({ poolAddress, lpToken: poolAddress, coins });
  }
  return pools;
}
```

- [ ] **Step 2: Update `bootApplication` in `boot.ts` to use new implementation**

```typescript
// src/orchestrator/boot.ts
import { fetchCurvePools } from "../services/discovery/curve_discovery.ts";
// ...

  const fetchCurvePoolsImpl = async (factoryAddress: Address) => {
    return await fetchCurvePools(publicClient, factoryAddress);
  };

  const discoveryDeps: DiscoveryServiceDeps = {
    logger,
    decodeLog,
    fetchTokenMeta,
    fetchCurvePools: fetchCurvePoolsImpl,
    savePool,
  };
```

### Task 2: Instrument DiscoveryService for TUI

**Files:**
- Modify: `src/services/discovery/service.ts`

- [ ] **Step 1: Add progress reporting to `DiscoveryService`**

```typescript
// Add an optional progress callback to DiscoveryService
export class DiscoveryService {
  constructor(private deps: DiscoveryServiceDeps, private onProgress?: (progress: BotActivityProgress) => void) {}
  
  // Update discoverProtocol to report progress
}
```

### Task 3: Verify and Commit

- [ ] **Step 1: Run Typecheck**
Run: `pnpm run typecheck`
Expected: PASS

- [ ] **Step 2: Run Tests**
Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: Commit**
```bash
git add src/services/discovery/curve_discovery.ts src/orchestrator/boot.ts src/services/discovery/service.ts
git commit -m "feat: implement Curve pool discovery logic and TUI progress reporting"
```
