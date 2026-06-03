# llm.md — AI / LLM Context Entry Point (see llms.txt for the full index)

This is the short entry for agents/LLMs. Read in order:

1. AGENTS.md — architecture, rules, hot path, invariants, key commands, onboarding.
2. skill.md — capabilities, workflows, Envio skills, arb-tx-tools.
3. llms.txt — detailed discovery (architecture post-audit, AI tooling, MCPs, lspmux, commands, indexing).
4. README.md — high level + quickstart.
5. .grok/skills/arb-tx-tools/SKILL.md — the primary debugging superpower (direct CLIs or MCP).
6. .claude/skills/_ (especially graphify, the indexer-_ suite, migrate-from-subgraph).

## Current run commands (package.json)

- `bun run tui` (full + TUI, recommended)
- `bun run start` (headless)
- `bun run arb` / `bun run arbt` (arb-only headless / +TUI; use with `bun run dev`)
- `bun run dev` (HyperIndex standalone, with auto-codegen)
- `bun run check` (tsc+eslint+prettier)
- `bun run fix`
- Tests: `bunx vitest run`
- AI direct: `bun .grok/skills/arb-tx-tools/scripts/log-tailer.ts ...` (simulator, abicoder too)
- MCP arb-tx-tools: `bun run scripts/arb-tx-tools.ts`

## Skills & MCP best usage

- Skills: `/arb-tx-tools`, `/graphify` (any input → kg), indexer-\*, `/best-of-n` etc. Auto on keywords where possible.
- MCPs: `search_tool` first (to get schema), then `use_tool` with exact names/args. See connected: arb-tx-tools, alchemy (sim/trace), context7, envio_docs, postgres, memory, fetch, sequential-thinking, etc.
- lspmux: language server multiplexer (127.0.0.1:27631). Config lspmux/config.toml, bins in lspmux/bin/. Point your AI coding env here for consistent LSP features (TS/Solidity/GraphQL etc.) without dup servers.
- Context7: for any lib docs.
- graphify: `/graphify` for codebase understanding.

## Key single sources (post audit)

- RpcManager for all RPC
- garbage-tracker for isGarbage\* + KNOWN_INDEXED_FACTORIES
- pipeline/ for graph (createEdgesForPool), finder, rates, sim
- arb-tx-tools shared modules for debug
- auto codegen in scripts/dev-hyperindex.ts + hyperindex_process (mtime gate)
- routeKey identity (not hash) for tracking/quarantine

No dummy cleanup.sh, no getPools, no tax code, no strategy/.

See llms.txt for exhaustive current details. Run `bun run check` early and often.
