# Task 5: Sync Optimization & Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize the indexer's sync start block for Polygon and remove an unused effect file.

**Architecture:** Update environment-variable-backed configuration for better default behavior and perform codebase cleanup.

**Tech Stack:** YAML, Envio (Indexer)

---

### Task 1: Update start blocks in config.yaml

**Files:**
- Modify: `hyperindex/config.yaml`

- [ ] **Step 1: Update Polygon start block**

In `hyperindex/config.yaml`, update `start_block` for `id: 137` from `${POLYGON_START_BLOCK:-0}` to `${POLYGON_START_BLOCK:-58000000}`.

```yaml
  - id: 137
    start_block: ${POLYGON_START_BLOCK:-58000000}
```

### Task 2: Remove unused effect file

**Files:**
- Delete: `hyperindex/src/effects/token_decimals.ts`

- [ ] **Step 1: Delete the file**

Run: `rm hyperindex/src/effects/token_decimals.ts`

### Task 3: Commit changes

- [ ] **Step 1: Stage and commit**

```bash
git add hyperindex/config.yaml
git rm hyperindex/src/effects/token_decimals.ts
git commit -m "perf(indexer): optimize sync start block and clean up"
```
