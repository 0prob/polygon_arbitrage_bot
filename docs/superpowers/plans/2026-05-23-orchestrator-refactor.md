# Orchestration Refactor: Lifecycle & Dependency Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a structured lifecycle and dependency management system for the bot.

**Architecture:** Introduce a `Lifecycle` interface and `BotSystem` class to encapsulate bot services, allowing for cleaner startup, shutdown, and runtime access to system dependencies.

**Tech Stack:** TypeScript, Node.js

---

### Task 1: Create Lifecycle Interface

**Files:**
- Create: `src/orchestrator/lifecycle.ts`

- [ ] **Step 1: Write lifecycle.ts**

```typescript
export interface Lifecycle {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator/lifecycle.ts
git commit -m "feat(orchestrator): add lifecycle interface"
```

### Task 2: Create BotSystem Class

**Files:**
- Create: `src/orchestrator/system.ts`

- [ ] **Step 1: Write system.ts**

```typescript
import type { AppConfig } from "../config/schema.ts";
import { type Logger } from "../infra/observability/logger.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { ExecutionService } from "../services/execution/service.ts";
import { MempoolService } from "../services/mempool/service.ts";
import { GasOracle } from "../services/execution/gas.ts";
import { CrossChainScanner } from "../services/crosschain/scanner.ts";
import { SolverBot } from "../services/crosschain/solver.ts";
import { type PublicClient } from "viem";
import type { RouteStateCache } from "../core/types/route.ts";
import type { PoolMeta } from "../core/types/pool.ts";

export interface BotContext {
  config: AppConfig;
  logger: Logger;
  stateCache: RouteStateCache;
  executionService: ExecutionService;
  mempoolService: MempoolService;
  publicClient: PublicClient;
  gasOracle: GasOracle;
  crossChainScanner?: CrossChainScanner;
  solverBot?: SolverBot;
  getPools: () => PoolMeta[];
}

export class BotSystem implements Lifecycle {
  constructor(private context: BotContext) {}

  async prepare(): Promise<void> {
    this.context.logger.info("BotSystem preparing...");
  }

  async start(): Promise<void> {
    this.context.logger.info("BotSystem starting...");
  }

  async stop(): Promise<void> {
    this.context.logger.info("BotSystem stopping...");
  }

  getContext(): BotContext {
    return this.context;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator/system.ts
git commit -m "feat(orchestrator): add BotSystem class"
```

### Task 3: Refactor boot.ts to use BotSystem

**Files:**
- Modify: `src/orchestrator/boot.ts`

- [ ] **Step 1: Update boot.ts**

*Replace `bootApplication` return type and implementation to return `BotSystem`.*

```typescript
// ... (imports)
import { BotSystem, type BotContext } from "./system.ts";

// ... (existing helper definitions)

export async function bootApplication(config: AppConfig, logBuffer?: string[]): Promise<BotSystem> {
  // ... (logger, clients, services creation - no changes to these)

  const context: BotContext = {
    config,
    logger,
    stateCache,
    executionService,
    mempoolService,
    getPools,
    publicClient,
    gasOracle,
    crossChainScanner,
    solverBot,
  };

  const system = new BotSystem(context);
  logger.info("Ready — system initialized");

  return system;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator/boot.ts
git commit -m "refactor(orchestrator): use BotSystem in bootApplication"
```
