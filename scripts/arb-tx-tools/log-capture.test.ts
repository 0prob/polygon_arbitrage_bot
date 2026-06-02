import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LogCapture } from "./log-capture.ts";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("LogCapture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), "arb-tx-tools-test-log");
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("starts empty", () => {
    const capture = new LogCapture(1000);
    expect(capture.getAll()).toHaveLength(0);
  });

  it("captures manually pushed entries", () => {
    const capture = new LogCapture(1000);
    capture.push("INFO", "hello");
    capture.push("ERROR", "world");
    const all = capture.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].level).toBe("INFO");
    expect(all[1].level).toBe("ERROR");
  });

  it("filters by errors-only", () => {
    const capture = new LogCapture(1000);
    capture.push("INFO", "ok");
    capture.push("ERROR", "fail");
    capture.push("FATAL", "boom");
    const errors = capture.getLogs({ errorsOnly: true });
    expect(errors).toHaveLength(2);
  });

  it("filters by regex", () => {
    const capture = new LogCapture(1000);
    capture.push("INFO", "processing block 123");
    capture.push("ERROR", "RPC rate limit hit");
    const filtered = capture.getLogs({ filter: "rate limit" });
    expect(filtered).toHaveLength(1);
  });

  it("respects max lines (ring buffer)", () => {
    const capture = new LogCapture(3);
    capture.push("INFO", "a");
    capture.push("INFO", "b");
    capture.push("INFO", "c");
    capture.push("INFO", "d");
    expect(capture.getAll()).toHaveLength(3);
    expect(capture.getAll()[0].message).toBe("b");
  });

  it("tracks error count", () => {
    const capture = new LogCapture(1000);
    capture.push("INFO", "ok");
    capture.push("ERROR", "e1");
    capture.push("WARN", "w");
    capture.push("FATAL", "f1");
    expect(capture.errorCount).toBe(2);
  });

  it("filters by since timestamp", () => {
    const capture = new LogCapture(1000);
    capture.push("INFO", "old");
    capture.push("INFO", "new");
    const result = capture.getLogs({ since: "2100-01-01T00:00:00.000Z" });
    expect(result).toHaveLength(0);
    const all = capture.getLogs({ since: "1970-01-01T00:00:00.000Z" });
    expect(all).toHaveLength(2);
  });

  it("getStatus returns correct info", () => {
    const capture = new LogCapture(1000);
    expect(capture.getStatus().totalLines).toBe(0);
    expect(capture.getStatus().errorCount).toBe(0);
    expect(capture.getStatus().lastTimestamp).toBeNull();

    capture.push("INFO", "test");
    const status = capture.getStatus();
    expect(status.totalLines).toBe(1);
    expect(typeof status.lastTimestamp).toBe("string");
  });
});
