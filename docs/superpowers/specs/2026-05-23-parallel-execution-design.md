# Parallel Execution Pipeline Design

## Overview
Transform transaction submission from a single-path, blocking process into an asynchronous, parallel broadcast pipeline.

## Current Architecture
- `ExecutionService.execute` is synchronous and sequential.
- Submits via a single `submitTx` function, which uses one RPC client.
- Blocked by execution result latency before moving to the next opportunity.

## Proposed Architecture
1. **Flash-Submission Path**: Introduce an asynchronous execution path for high-profit opportunities that broadcasts to multiple relays (Flashbots, etc.) simultaneously via Viem.
2. **Execution Broker**: Refactor `ExecutionService` to manage multiple submission channels (Relays) in parallel.
3. **Optimistic Nonce Handling**: Allow multiple pending transactions from the same account with incrementing nonces to be submitted simultaneously (if the relay/network supports bundle ordering).

## Key Components
- **RelayRegistry**: A registry of supported relay endpoints.
- **Async Broadcast**: Parallel `submitTx` calls to multiple endpoints.
- **Race Monitor**: Track which channel wins (first confirmed txHash) and cancel others (if possible).

**Does this parallel submission approach align with your infrastructure capabilities, and are there specific relay providers you prefer?**
