 * FastLane / Flashbots Priority: Ensure FastLaneSubmitter is fully tuned in config.yaml.
 * Predictive Dry-Running: Currently, the dry-runner checks the current state. Upgrade to
   simulate against pending block (including own and others' mempool transactions)
 * Rust Math Acceleration: Move core sqrtPriceMath and tickMath to a Rust worker thread to leverage SIMD
   instructions.
* JIT (Just-In-Time) Liquidity Service: dedicated service to monitor increaseLiquidity
  transactions in the mempool to "sandwich" the liquidity addition.
