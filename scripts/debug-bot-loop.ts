#!/usr/bin/env bun
/** @deprecated Use `bun run debug` (scripts/debug-run.ts). */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const r = spawnSync("bun", ["run", join(import.meta.dir, "debug-run.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: join(import.meta.dir, ".."),
});
process.exit(r.status ?? 1);
