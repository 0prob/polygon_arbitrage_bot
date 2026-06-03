#!/usr/bin/env bun
/**
 * Log Tailer - Runtime TypeScript Error & Stack Trace Feeder for the AI
 *
 * Feeds relevant runtime errors from the arbitrage bot directly to the AI agent.
 * Great for instantly diagnosing unhandled promise rejections, JSON-RPC rate limits,
 * connection drops, hyperindex issues, execution failures, etc.
 *
 * Usage:
 *   bun .grok/skills/arb-tx-tools/scripts/log-tailer.ts --last 100
 *   bun .grok/skills/arb-tx-tools/scripts/log-tailer.ts --follow --filter "error|rejection|rate|rpc"
 *   bun .grok/skills/arb-tx-tools/scripts/log-tailer.ts --search "unhandled" --since 10m
 *
 * The bot (when run with TUI or fileMode) writes structured pino logs to data/runner.log
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

// Consolidated: reuse LogCapture from the MCP/shared modules for ring buffer, fs.watch follow, and pino parsing logic.
import { LogCapture } from "../../../../scripts/arb-tx-tools/log-capture.ts";

const DEFAULT_LOG = path.resolve(import.meta.dir, "../../../../data/runner.log");
const TUI_LOG_HINT = "data/runner.log (written when TUI or --file-log active)";

interface TailOptions {
  logPath: string;
  last: number;
  follow: boolean;
  filter?: RegExp;
  search?: string;
  json: boolean;
  errorsOnly: boolean;
}

function parseArgs(argv: string[]): TailOptions {
  const o: any = { logPath: DEFAULT_LOG, last: 80, follow: false, json: false, errorsOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--last" || a === "-n") o.last = parseInt(argv[++i] || "80", 10);
    else if (a === "--follow" || a === "-f") o.follow = true;
    else if (a === "--file" || a === "--path") o.logPath = argv[++i];
    else if (a === "--filter") o.filter = new RegExp(argv[++i], "i");
    else if (a === "--search") o.search = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--errors" || a === "--errors-only") o.errorsOnly = true;
    else if (!a.startsWith("-") && !o.logPathOverridden) {
      o.logPath = a;
      o.logPathOverridden = true;
    }
  }
  return o as TailOptions;
}

function formatLine(line: string, jsonMode: boolean): string {
  if (!line.trim()) return "";
  if (jsonMode) return line;

  try {
    const obj = JSON.parse(line);
    const time = obj.time || obj.ts || "";
    const level = obj.level >= 50 ? "ERROR" : obj.level >= 40 ? "WARN" : "INFO";
    const msg = obj.msg || obj.message || "";
    const ctx = obj.context ? ` [${JSON.stringify(obj.context)}]` : "";
    const err = obj.err || obj.error ? `\n  Error: ${obj.err?.message || obj.error?.stack?.split("\n")[0] || ""}` : "";
    const stack = (obj.stack || obj.err?.stack || obj.error?.stack || "").split("\n").slice(0, 6).join("\n  ");
    return `[${time.slice(11, 19)}] ${level}: ${msg}${ctx}${err}${stack ? "\n  Stack: " + stack : ""}`;
  } catch {
    // plain text line
    return line;
  }
}

function isInteresting(line: string, opts: TailOptions): boolean {
  const l = line.toLowerCase();
  if (opts.errorsOnly && !/error|fatal|revert|reject|fail|limit|timeout|rate|unhandled|promise/i.test(l)) return false;
  if (opts.filter && !opts.filter.test(line)) return false;
  if (opts.search && !line.toLowerCase().includes(opts.search.toLowerCase())) return false;
  return true;
}

function tailFile(opts: TailOptions) {
  const p = opts.logPath;
  if (!fs.existsSync(p)) {
    console.error(`Log file not found: ${p}`);
    console.error(`Hint: Run the bot with TUI (bun run src/cli/main.ts --tui) or ensure fileMode logging is on.`);
    console.error(`Alternative: tail -f ${TUI_LOG_HINT}`);
    process.exit(1);
  }

  // Use shared LogCapture for ring buffer + watch logic (consolidates duplication with MCP modules)
  const max = Math.max(2000, opts.last || 200);
  const capture = new LogCapture(max);

  // Preload recent lines by parsing and pushing to shared capture (reuses its pino parser)
  const content = fs.readFileSync(p, "utf8");
  const allLines = content.trim().split("\n");
  const recent = opts.last > 0 ? allLines.slice(-opts.last) : allLines;
  for (const line of recent) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const level = (parsed.level ?? "INFO").toString().toUpperCase();
      const msg = parsed.msg ?? parsed.message ?? line;
      capture.push(level, msg, line);
    } catch {
      capture.push("INFO", line, line);
    }
  }

  console.log(`=== Log Tailer: ${p} (last ${opts.last || "all"} lines, filtered) ===\n`);

  // Get filtered via shared (supports last, errorsOnly, filter regex, since)
  const filterRe = opts.filter || (opts.search ? new RegExp(opts.search, "i") : undefined);
  let entries = capture.getLogs({
    last: opts.last || undefined,
    errorsOnly: opts.errorsOnly,
    filter: filterRe,
  });

  // Further apply CLI's isInteresting for search/errors heuristic if needed (backward compat)
  if (opts.search || opts.errorsOnly) {
    entries = entries.filter((e) => isInteresting(e.raw || e.message, opts));
  }

  let printed = 0;
  for (const e of entries) {
    const line = e.raw || `${e.timestamp} ${e.level} ${e.message}`;
    if (isInteresting(line, opts)) {
      console.log(formatLine(line, opts.json));
      printed++;
    }
  }
  if (!printed) console.log("(no matching lines in recent history)");

  if (!opts.follow) return;

  console.log("\n--- Following (Ctrl-C to stop) ---\n");
  capture.startWatching(p);

  // Drain loop: periodically get new from capture's buffer (the watch populates it)
  let lastCount = capture.getAll().length;
  const iv = setInterval(() => {
    const all = capture.getAll();
    const newEntries = all.slice(lastCount);
    for (const e of newEntries) {
      const line = e.raw || e.message;
      if (isInteresting(line, opts)) {
        console.log(formatLine(line, opts.json));
      }
    }
    lastCount = all.length;
  }, 250);

  process.on("SIGINT", () => {
    clearInterval(iv);
    capture.stop();
    process.exit(0);
  });
}

function printHelp() {
  console.log(`Log Tailer for Arb Bot Runtime Diagnostics

Specialized for feeding AI actionable stack traces & errors:
- Unhandled promise rejections
- JSON-RPC rate limits / timeouts / connection resets
- HyperIndex / Hasura failures
- Execution reverts & submission errors
- Any pino ERROR/FATAL with stack

Commands / Flags:
  [default]                     Show last ~80 interesting lines
  --last 200                    Show last N lines
  --follow, -f                  Tail -f mode (live updates)
  --filter "rejection|rate"     Only lines matching regex (case-insens)
  --search "flashloan"          Substring search
  --errors-only                 Only ERROR/FATAL + common failure keywords
  --file /path/to/other.log     Override default data/runner.log
  --json                        Emit raw JSON lines

Examples (for the AI agent):
  bun .grok/skills/arb-tx-tools/scripts/log-tailer.ts --last 150 --errors-only
  bun .grok/skills/arb-tx-tools/scripts/log-tailer.ts --follow --filter "unhandled|promise|rate limit|JSON-RPC"

When the bot is running under the TUI, logs go to data/runner.log automatically.
For raw stderr (node unhandledRejection), also run the bot with: node --trace-warnings ...
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const opts = parseArgs(process.argv);
  tailFile(opts);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
