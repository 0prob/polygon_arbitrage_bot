import { Writable } from "stream";
import pino, { type Logger as PinoLogger, type Level, type DestinationStream } from "pino";
import type { LogLevel } from "../../core/types/common.ts";

export type Logger = PinoLogger;

export interface LoggerOptions {
  level: LogLevel;
  /** When true, log to a file at `data/runner.log` (used when TUI is active). */
  fileMode?: boolean;
  filePath?: string;
  /** Pretty-print to stdout (for dev). */
  pretty?: boolean;
  /** Optional list sink. When set, formatted log lines are pushed here in addition to normal output. */
  logSink?: string[];
  /** Max entries in logSink ring buffer. */
  logSinkMax?: number;
}

const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

function createLogSinkStream(sink: string[], max: number): DestinationStream {
  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const raw = chunk.toString().trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          const label = LEVEL_LABELS[parsed.level] ?? "INFO";
          const msg = parsed.msg ?? "";
          sink.unshift(`[${label}] ${msg}`);
          if (sink.length > max) sink.length = max;
        } catch {
          sink.unshift(raw);
          if (sink.length > max) sink.length = max;
        }
      }
      process.stderr.write(raw + "\n");
      callback();
    },
    objectMode: false,
  });
}

/** Create a root logger. */
export function createRootLogger(opts?: Partial<LoggerOptions>): Logger {
  const level = (opts?.level ?? "info") as Level;
  const baseConfig: pino.LoggerOptions = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts?.logSink) {
    const sink = opts.logSink;
    const max = opts.logSinkMax ?? 100;
    return pino(baseConfig, createLogSinkStream(sink, max));
  }

  if (opts?.fileMode && opts?.filePath) {
    return pino(baseConfig, pino.destination({ dest: opts.filePath, sync: false }));
  }

  if (opts?.pretty) {
    return pino({
      ...baseConfig,
      transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } },
    });
  }

  return pino(baseConfig);
}

/** Create a child logger with bound context. */
export function childLogger(parent: Logger, context: Record<string, unknown>): Logger {
  return parent.child(context);
}
