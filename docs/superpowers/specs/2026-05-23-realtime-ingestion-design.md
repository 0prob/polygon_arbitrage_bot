# Real-Time Pool Ingestion Design

## Overview
Implement WebSocket-based pool state updates to move from polling to real-time event-driven updates.

## Architecture
1. **Transport Layer**: Add `webSocket()` transport via `viem` to the client factory.
2. **Ingestion Engine**: Create `PoolStateSubscriber` that subscribes to `logs` or specific `contract` events.
3. **State Sync**: Hook subscriber updates into the existing `stateCache` used by `PassRunner`.

## Implementation Approaches
1. **Viem WebSocket**: Use `viem`'s built-in `webSocket` transport with `watchContractEvent` or `watchLogs`.
2. **Envio WebSocket**: If Envio/Hyperindex supports native WebSocket events, use their client.

**Recommendation**: Use `viem`'s `webSocket` transport and `watchContractEvent` for core protocols to keep dependencies minimal.

## Questions for implementation
1. Do you have a dedicated WebSocket endpoint URL for your RPC provider?
2. Are there specific protocols (e.g., Uniswap V3 only vs all) you want prioritized for real-time ingestion initially?

**What do you think of prioritizing V3+WebSocket as the initial phase?**
