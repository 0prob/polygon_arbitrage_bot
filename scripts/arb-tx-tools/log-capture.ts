import { watch, FSWatcher } from "fs";
import { readFileSync, existsSync } from "fs";

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  raw: string;
}

export interface GetLogsOptions {
  last?: number;
  errorsOnly?: boolean;
  filter?: string;
  since?: string;
}

export class LogCapture {
  private buffer: LogEntry[] = [];
  private maxLines: number;
  private fileWatcher: FSWatcher | null = null;
  private fileSize = 0;
  public errorCount = 0;

  constructor(maxLines = 1000) {
    this.maxLines = maxLines;
  }

  push(level: string, message: string, raw?: string): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      raw: raw ?? message,
    };
    if (this.buffer.length >= this.maxLines) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
    if (level === "ERROR" || level === "FATAL") {
      this.errorCount++;
    }
  }

  startWatching(filePath: string): void {
    if (!existsSync(filePath)) return;

    this.fileSize = readFileSync(filePath).length;

    this.fileWatcher = watch(filePath, (eventType) => {
      if (eventType !== "change") return;
      try {
        const content = readFileSync(filePath, "utf-8");
        const newContent = content.slice(this.fileSize);
        this.fileSize = content.length;
        if (!newContent) return;

        for (const line of newContent.split("\n").filter(Boolean)) {
          try {
            const parsed = JSON.parse(line);
            const level = (parsed.level ?? "INFO").toUpperCase();
            const msg = parsed.msg ?? parsed.message ?? line;
            this.push(level, msg, line);
          } catch {
            this.push("INFO", line, line);
          }
        }
      } catch {
        this.fileSize = 0;
      }
    });
  }

  stop(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  getAll(): LogEntry[] {
    return [...this.buffer];
  }

  getLogs(opts: GetLogsOptions = {}): LogEntry[] {
    let entries = this.buffer;

    if (opts.errorsOnly) {
      entries = entries.filter((e) => e.level === "ERROR" || e.level === "FATAL");
    }
    if (opts.filter) {
      const re = new RegExp(opts.filter, "i");
      entries = entries.filter((e) => re.test(e.message));
    }
    if (opts.since) {
      const since = new Date(opts.since).getTime();
      entries = entries.filter((e) => new Date(e.timestamp).getTime() > since);
    }
    if (opts.last && opts.last > 0) {
      entries = entries.slice(-opts.last);
    }

    return entries;
  }

  getStatus(): { totalLines: number; errorCount: number; lastTimestamp: string | null } {
    return {
      totalLines: this.buffer.length,
      errorCount: this.errorCount,
      lastTimestamp: this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].timestamp : null,
    };
  }
}
