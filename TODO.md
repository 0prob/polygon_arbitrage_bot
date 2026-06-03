- FastLane / Flashbots Priority: Ensure FastLaneSubmitter is fully tuned in config.yaml.
- Predictive Dry-Running: Currently, the dry-runner checks the current state. Upgrade to
  simulate against pending block (including own and others' mempool transactions)
- Rust Math Acceleration: Move core sqrtPriceMath and tickMath to a Rust worker thread to leverage SIMD
  instructions.
- JIT (Just-In-Time) Liquidity Service: dedicated service to monitor increaseLiquidity
  transactions in the mempool to "sandwich" the liquidity addition.

## Debug 2026-05 Follow-ups (from DEBUG_OPTIMIZATIONS.md)

- Incremental computeMaticRates (dirty tracking via state versions or graphUpdater)
- Kill `as any` in hot simulation paths (uniswap_v3, pipeline evaluateAmount, fetcher results)
- Bounded/TTL structure for recentRouteTimestamps
- HF cycle budget instrumenter (warn if >150 ms of work inside 200 ms loop)
- Property-based load test for 5k+ pools / 50k cycles in evaluatePipeline
- Replace manual array LRU in V3 cache with pure cap FIFO (even cheaper)
- Replace remaining console.\* in infra with proper logger injection
- (Done in next pass) Incremental rates via seedRates (see DEBUG_OPTIMIZATIONS.md)
- (Done) V3 tick cache reduced to pure size-cap Map (no more O(n) work)
- (Done) Lightweight HF budget tripwire + maxHotPathDurationMs metric
- (Done in third pass) fetchMissingPoolState now returns updated addresses; full focusTokens + dirty-pool prioritization + targeted final sweep in computeMaticRates
- (Done) maxHotPathMs exposed in StatusPayload / status.json (visible to TUI + health)
- (Done, full audit) 2026-06 comprehensive file-by-file: dead getPools excised, garbage+factories+address-norm+routeKey consolidated to single sources, latent candidate routeKey=hash bug fixed (was poisoning poolsFrom/quarantine/inflight/tracker), dangling sol interfaces+lib removed (0 refs), all syntax/logic verified, tests+type green.
