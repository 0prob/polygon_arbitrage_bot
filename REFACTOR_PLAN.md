# Refactor Plan: Move runLfStateRefresh to StateRefreshService

## Objective
Decouple `runLfStateRefresh` from the main loop in `runPassLoop` and make it a background service.

## Plan

### Task 1: Refactor `runLfStateRefresh` and helpers to `StateRefreshService`
- Copy `runLfStateRefresh`, `runPoolDiscovery`, and `runBootstrapInBackground` (and any other necessary helpers) to `src/services/state_refresh.ts`.
- Update `StateRefreshService` to hold these methods.
- Ensure `StateRefreshService` has all dependencies it needs (ctx, deps, bus, etc.).

### Task 2: Remove blocking call from `runPassLoop`
- Delete `runLfStateRefresh` and `runPoolDiscovery` from `src/orchestrator/pass_loop.ts`.
- Remove the call to `runLfStateRefresh` and `runPoolDiscovery` inside `runPassLoop`.
- Adjust `runPassLoop` to rely on `StateRefreshService` if needed, or if `StateRefreshService` updates `ctx.stateCache` directly, `runPassLoop` will pick it up.

### Task 3: Update `boot.ts`
- Instantiate `StateRefreshService` in `bootApplication`.
- Start it.

### Testing Strategy
- Ensure `stateCache` is still being updated as expected.
- Check logs for "StateRefreshService started".
- Run the bot and verify no regression in pool discovery/state refresh.
