# Graph Report - t  (2026-05-18)

## Corpus Check
- 109 files · ~39,551 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 49 nodes · 47 edges · 6 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `61775fe5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]

## God Nodes (most connected - your core abstractions)
1. `scripts` - 8 edges
2. `Architecture` - 7 edges
3. `Polygon DEX Arbitrage Bot` - 5 edges
4. `Development` - 4 edges
5. `Setup` - 2 edges
6. `Operation` - 2 edges
7. `engines` - 2 edges
8. `Core (`src/core/`)` - 1 edges
9. `Config (`src/config/`)` - 1 edges
10. `Infrastructure (`src/infra/`)` - 1 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities (6 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.20
Nodes (10): devDependencies, eslint, eslint-config-prettier, fast-check, prettier, @types/node, typescript, typescript-eslint (+2 more)

### Community 1 - "Community 1"
Cohesion: 0.20
Nodes (9): code:block1 (git clone <repo>), code:block2 (pnpm start), Configuration, Development, Operation, Polygon DEX Arbitrage Bot, Prerequisites, Setup (+1 more)

### Community 2 - "Community 2"
Cohesion: 0.25
Nodes (7): engines, node, main, name, packageManager, type, version

### Community 3 - "Community 3"
Cohesion: 0.25
Nodes (8): scripts, fmt, fmt:fix, lint, lint:fix, start, start:tui, typecheck

### Community 4 - "Community 4"
Cohesion: 0.29
Nodes (7): Architecture, CLI (`src/cli/`), Config (`src/config/`), Core (`src/core/`), Infrastructure (`src/infra/`), Orchestrator (`src/orchestrator/`), Services (`src/services/`)

### Community 5 - "Community 5"
Cohesion: 0.33
Nodes (6): dependencies, @envio-dev/hypersync-client, pino, tsx, viem, zod

## Knowledge Gaps
- **38 isolated node(s):** `Core (`src/core/`)`, `Config (`src/config/`)`, `Infrastructure (`src/infra/`)`, `Services (`src/services/`)`, `Orchestrator (`src/orchestrator/`)` (+33 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `Community 0` to `Community 2`?**
  _High betweenness centrality (0.207) - this node is a cross-community bridge._
- **Why does `scripts` connect `Community 3` to `Community 2`?**
  _High betweenness centrality (0.168) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Community 5` to `Community 2`?**
  _High betweenness centrality (0.124) - this node is a cross-community bridge._
- **What connects `Core (`src/core/`)`, `Config (`src/config/`)`, `Infrastructure (`src/infra/`)` to the rest of the system?**
  _38 weakly-connected nodes found - possible documentation gaps or missing edges._