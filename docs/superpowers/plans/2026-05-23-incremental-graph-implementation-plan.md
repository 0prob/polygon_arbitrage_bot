# Incremental Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement incremental graph updates for localized pool state changes.

**Architecture:**
1. **GraphManager**: Manage the `RoutingGraph` and provide an `updatePool(address: Address, state: PoolState)` API.
2. **Integration**: Update `PassRunner` and `PoolStateSubscriber` to use `GraphManager`.

---

### Task 1: Create GraphManager
**Files:**
- Create: `src/services/strategy/graph_manager.ts`
- Test: `src/services/strategy/graph_manager.test.ts`

- [ ] **Step 1: Implement GraphManager**
Implement `GraphManager` class to encapsulate `RoutingGraph` and handle pool-level updates.

- [ ] **Step 2: Add tests**
Verify that `updatePool` correctly updates only the targeted edge in the adjacency list.

---

### Task 2: Integrate GraphManager
**Files:**
- Modify: `src/orchestrator/pass_loop.ts`
- Modify: `src/services/mempool/subscriber.ts`

- [ ] **Step 1: PassRunner Update**
Replace the `cachedGraph` rebuild with `GraphManager.updatePool` when state changes are detected.

- [ ] **Step 2: Subscriber Update**
Ensure `PoolStateSubscriber` calls `GraphManager.updatePool` immediately upon receiving an event.

