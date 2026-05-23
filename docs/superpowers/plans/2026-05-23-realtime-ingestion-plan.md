# Real-Time Pool Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement WebSocket-based pool state updates using Viem to reduce arbitrage latency.

**Architecture:**
1. Update `ClientFactory` to support `webSocket` transports.
2. Create `PoolStateSubscriber` service.
3. Hook subscriber updates directly into `RouteStateCache`.

**Tech Stack:** Bun, Viem, TypeScript.

---

### Task 1: Update Client Factory for WebSocket
- Modify: `src/infra/rpc/client_factory.ts`

- [ ] **Step 1: Add WebSocket support**
Extend `ClientFactoryOptions` to support `wsUrl`. Add `createWebSocketClient` to `ClientFactory`.

---

### Task 2: Implement PoolStateSubscriber
- Create: `src/services/mempool/subscriber.ts`

- [ ] **Step 1: Create Subscriber**
Implement `PoolStateSubscriber` using `viem`'s `watchContractEvent` for V3 pools.
- [ ] **Step 2: State Integration**
Provide a callback method that updates the `RouteStateCache` when events trigger state refreshes.

---

### Task 3: Integrate with BotSystem
- Modify: `src/orchestrator/system.ts`

- [ ] **Step 1: Initialize Subscriber**
Initialize `PoolStateSubscriber` in `BotSystem` and start/stop with bot lifecycle.

