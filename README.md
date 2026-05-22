# Polygon Arb Bot

High-frequency arbitrage bot targeting Polygon (and cross-chain via Katana).

## Architecture

- `src/infra`: Database (HyperIndex), RPC (Viem), Observability (Pino).
- `src/core`: Math (Balancer, Curve), Pricing (Oracle), Types.
- `src/services`: Strategy (Graph, Finder, Pipeline), Execution (Builder, Service).
- `src/orchestrator`: Boot, Main Pass Loop.

## Getting Started

1. `cp .env.example .env` (Set `POLYGON_RPC`)
2. `bun install`
3. `bun start` (CLI) or `bun start:tui` (TUI)

## Testing

- `bun run test`: Run Vitest suite.
- `bun run typecheck`: Run TSC.
- `bun run lint`: Run ESLint.
