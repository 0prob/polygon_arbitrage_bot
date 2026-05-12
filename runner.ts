/**
 * runner.ts — Unified Arbitrage & Discovery Runner
 *
 * Runtime composition lives in src/app/runner_app.ts; this file only adapts the
 * Node process boundary into the app runner.
 */

import { createRunnerApp } from "./src/app/runner_app.ts";

const runnerApp = createRunnerApp({
  argv: process.argv.slice(2),
  env: process.env,
  processLike: process,
  exit: (code) => process.exit(code),
});

runnerApp.run().catch(runnerApp.handleFatal);
