#!/usr/bin/env bun
/**
 * Autonomous debug monitor — attaches to Bun inspector via CDP, sets breakpoints
 * at debug sites, collects metrics, and reports issues over a timed session.
 *
 * Usage: bun run scripts/debug-monitor.ts [--duration=1800] [--port=9229]
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const workspace = join(import.meta.dir, "..");
const port = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? process.env.BOT_DEBUG_PORT ?? "9229");
const durationSec = Number(process.argv.find((a) => a.startsWith("--duration="))?.split("=")[1] ?? "1800");
const outDir = join(workspace, "data", "debug-sessions");

/** Map debug sites → source files for breakpoint placement */
const BREAKPOINT_SITES: Array<{ site: string; file: string; pattern: string }> = [
  { site: "boot", file: "src/cli/arb_only_debug.ts", pattern: "debugBreak(DebugSites.BOOT" },
  { site: "pass-loop-start", file: "src/orchestrator/pass_loop.ts", pattern: "debugBreak(DebugSites.PASS_LOOP_START" },
  { site: "pass-loop-error", file: "src/orchestrator/pass_loop.ts", pattern: "debugBreak(DebugSites.PASS_LOOP_ERROR" },
  { site: "profitable-found", file: "src/orchestrator/pass_hf.ts", pattern: "debugBreak(DebugSites.PROFITABLE_FOUND" },
  { site: "pipeline-cycle-error", file: "src/pipeline/pipeline.ts", pattern: "debugBreak(DebugSites.PIPELINE_CYCLE_ERROR" },
  { site: "tx-submit", file: "src/services/execution/submit.ts", pattern: "debugBreak(DebugSites.TX_SUBMIT" },
  { site: "tx-result", file: "src/services/execution/service.ts", pattern: "debugBreak(DebugSites.TX_RESULT" },
  { site: "fatal", file: "src/cli/arb_only_debug.ts", pattern: "debugBreak(DebugSites.FATAL" },
];

interface SessionMetrics {
  startedAt: number;
  durationSec: number;
  breakpointsSet: number;
  breakpointHits: Record<string, number>;
  consoleErrors: string[];
  consoleWarnings: string[];
  pausedEvents: number;
  exceptions: string[];
  inspectorConnected: boolean;
  lastActivity: number;
}

const metrics: SessionMetrics = {
  startedAt: Date.now(),
  durationSec,
  breakpointsSet: 0,
  breakpointHits: {},
  consoleErrors: [],
  consoleWarnings: [],
  pausedEvents: 0,
  exceptions: [],
  inspectorConnected: false,
  lastActivity: Date.now(),
};

async function waitForInspector(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = (await res.json()) as Array<{ webSocketDebuggerUrl?: string }>;
        if (list.length > 0 && list[0].webSocketDebuggerUrl) return true;
      }
    } catch {
      /* retry */
    }
    await Bun.sleep(500);
  }
  return false;
}

async function getWsUrl(): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = (await res.json()) as Array<{ webSocketDebuggerUrl?: string }>;
    return list[0]?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

class CdpClient {
  private ws: WebSocket;
  private id = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private scripts = new Map<string, { scriptId: string; url: string }>();

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
    this.ws.onerror = () => {};
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("CDP connect failed"));
      setTimeout(() => reject(new Error("CDP connect timeout")), 10_000);
    });
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };

    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }

    if (msg.method === "Debugger.scriptParsed" && msg.params) {
      const url = String(msg.params.url ?? "");
      const scriptId = String(msg.params.scriptId ?? "");
      if (url.includes("/src/")) {
        this.scripts.set(url, { scriptId, url });
      }
    }

    if (msg.method === "Debugger.paused") {
      metrics.pausedEvents++;
      metrics.lastActivity = Date.now();
      const reason = (msg.params as { reason?: string })?.reason ?? "unknown";
      const hitKey = `paused:${reason}`;
      metrics.breakpointHits[hitKey] = (metrics.breakpointHits[hitKey] ?? 0) + 1;
      void this.send("Debugger.resume", {});
    }

    if (msg.method === "Runtime.exceptionThrown" && msg.params) {
      const details = (msg.params as { exceptionDetails?: { text?: string } }).exceptionDetails;
      const text = details?.text ?? JSON.stringify(msg.params).slice(0, 500);
      metrics.exceptions.push(text);
      metrics.lastActivity = Date.now();
    }

    if (msg.method === "Runtime.consoleAPICalled" && msg.params) {
      const p = msg.params as { type?: string; args?: Array<{ value?: unknown }> };
      const type = p.type ?? "log";
      const text = (p.args ?? []).map((a) => String(a.value ?? "")).join(" ");
      if (type === "error") {
        metrics.consoleErrors.push(text.slice(0, 500));
        if (metrics.consoleErrors.length > 200) metrics.consoleErrors.shift();
      } else if (type === "warning") {
        metrics.consoleWarnings.push(text.slice(0, 500));
        if (metrics.consoleWarnings.length > 200) metrics.consoleWarnings.shift();
      }
      metrics.lastActivity = Date.now();
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  async enable(): Promise<void> {
    await this.send("Runtime.enable");
    await this.send("Debugger.enable");
  }

  async setBreakpoints(): Promise<void> {
    await Bun.sleep(2000);
    for (const site of BREAKPOINT_SITES) {
      const absPath = join(workspace, site.file);
      const content = await Bun.file(absPath).text();
      const lineIdx = content.split("\n").findIndex((l) => l.includes(site.pattern));
      if (lineIdx < 0) continue;
      const lineNumber = lineIdx + 1;

      const script = [...this.scripts.values()].find((s) => s.url.endsWith(site.file));
      if (!script) continue;

      try {
        await this.send("Debugger.setBreakpointByUrl", {
          lineNumber,
          urlRegex: site.file.replace(/\./g, "\\."),
        });
        metrics.breakpointsSet++;
        metrics.breakpointHits[`set:${site.site}`] = 1;
      } catch {
        /* non-fatal */
      }
    }
  }

  close(): void {
    this.ws.close();
  }
}

async function writeReport(phase: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const sessionId = new Date(metrics.startedAt).toISOString().replace(/[:.]/g, "-");
  const path = join(outDir, `session-${sessionId}.json`);
  const report = {
    phase,
    ...metrics,
    elapsedSec: Math.round((Date.now() - metrics.startedAt) / 1000),
    uniqueErrors: [...new Set(metrics.consoleErrors)].slice(0, 50),
    uniqueWarnings: [...new Set(metrics.consoleWarnings)].slice(0, 50),
    uniqueExceptions: [...new Set(metrics.exceptions)].slice(0, 50),
  };
  await writeFile(path, JSON.stringify(report, null, 2));
  console.error(`[debug-monitor] report ${phase} → ${path}`);
}

async function main(): Promise<void> {
  console.error(`[debug-monitor] waiting for inspector on :${port} (${durationSec}s session)`);
  const ready = await waitForInspector(45_000);
  if (!ready) {
    console.error("[debug-monitor] FATAL: inspector not available");
    process.exit(1);
  }

  const wsUrl = await getWsUrl();
  if (!wsUrl) {
    console.error("[debug-monitor] FATAL: no websocket URL");
    process.exit(1);
  }

  const cdp = new CdpClient(wsUrl);
  await cdp.ready();
  metrics.inspectorConnected = true;
  console.error(`[debug-monitor] connected ${wsUrl}`);

  await cdp.enable();
  await cdp.setBreakpoints();
  console.error(`[debug-monitor] breakpoints set: ${metrics.breakpointsSet}`);

  const deadline = Date.now() + durationSec * 1000;
  const reportInterval = 5 * 60 * 1000;
  let nextReport = Date.now() + reportInterval;

  while (Date.now() < deadline) {
    await Bun.sleep(10_000);
    const elapsed = Math.round((Date.now() - metrics.startedAt) / 1000);
    const idle = Math.round((Date.now() - metrics.lastActivity) / 1000);
    console.error(
      `[debug-monitor] t=${elapsed}s paused=${metrics.pausedEvents} errors=${metrics.consoleErrors.length} exceptions=${metrics.exceptions.length} idle=${idle}s`,
    );

    if (Date.now() >= nextReport) {
      await writeReport("periodic");
      nextReport = Date.now() + reportInterval;
    }
  }

  await writeReport("final");
  cdp.close();
  console.error("[debug-monitor] session complete");
}

main().catch((err) => {
  console.error("[debug-monitor] error:", err);
  process.exit(1);
});
