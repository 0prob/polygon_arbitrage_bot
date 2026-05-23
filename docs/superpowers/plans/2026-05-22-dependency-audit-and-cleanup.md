# Workspace Dependency Audit & Clean Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize package.json scripts and audit dependencies to ensure only required packages are present.

**Architecture:** Standardize scripts for better developer experience and verify production dependencies.

**Tech Stack:** Bun, Vitest, ESLint, Prettier

---

### Task 1: Audit Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Audit Dependencies**
  - Verify that `fast-check` and `pino-pretty` are required for test and logging functionality.
  - They are used, so they should remain.

### Task 2: Standardize Scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Standardize scripts**
  - Update `package.json` with the following scripts:
    ```json
    "start": "bun run src/cli/main.ts",
    "test": "vitest run",
    "lint": "eslint src/",
    "fmt": "prettier --check src/"
    ```
  - Preserve `hi:*` scripts, but ensure they are consistent.

- [ ] **Step 2: Commit changes**
  - `git add package.json`
  - `git commit -m "chore: standardize scripts and prune dependencies"`
