#!/usr/bin/env node

process.env.NODE_ENV = "test";
process.env.POLYGON_RPC ??= "http://127.0.0.1:8545";
process.env.EXECUTION_RPC_URL ??= process.env.POLYGON_RPC;
process.env.GAS_ESTIMATION_RPC_URL ??= process.env.POLYGON_RPC;

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node --import=tsx scripts/run_ts_test.mjs <test-file> [...test-file]");
  process.exit(1);
}

let failures = 0;
for (const target of targets) {
  try {
    await import(new URL(`../${target}`, import.meta.url));
    console.log(`ok ${target}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok ${target}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
