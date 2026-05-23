# Polygon Arb Bot

High-frequency arbitrage bot for Polygon (chain 137) with cross-chain support for Katana. Executes multi-hop arbitrage across 12+ DEX protocols using flash loans.

## New Architecture

The bot has been refactored for improved reliability and testability:
- **BotSystem**: Centralized lifecycle management for all services (Execution, Mempool, RPC clients).
- **PassRunner**: Decoupled loop orchestration for precise execution control.
- **BotTestHarness**: Standardized integration testing framework.
- **Modular TUI**: Grid-based dashboard for real-time monitoring of component health and sync status.

## Features
- **Multi-protocol**: Uni V2/V3, Sushi V2/V3, QuickSwap V2/V3, Curve, Balancer, DODO, WooFi, KyberSwap, Uni V4.
- **Liquidity-Aware**: Prunes low-liquidity pools using automated USD-value calculation.
- **Performance**: Optimized pass loop with spatial pruning and pipeline early exits.
- **Monitoring**: TUI dashboard with live metrics, sync progress, and service health.

## Prerequisites
- **Bun** >=1.2.0
- **Envio API token**
- **Polygon RPC URLs**
- **Funded executor wallet**

## Quick Start
1. `cp .env.example .env`
2. `bun install`
3. `bun start` (CLI) or `bun start:tui` (Dashboard)

## Core Scripts
- `bun test`: Run all tests (vitest)
- `bun lint`: Linting (eslint)
- `bun fmt`: Prettier check
