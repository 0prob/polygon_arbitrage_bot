// ─── Typed error classes ─────────────────────────────────────────

export class ArbBotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = "ArbBotError";
  }
}

export class RpcError extends ArbBotError {
  constructor(
    message: string,
    public readonly url?: string,
  ) {
    super(message, "RPC_ERROR", true);
    this.name = "RpcError";
  }
}

export class CircuitOpenError extends ArbBotError {
  constructor(
    breakerName: string,
    public readonly msRemaining: number,
  ) {
    super(`Circuit '${breakerName}' is open (${msRemaining}ms remaining)`, "CIRCUIT_OPEN", true);
    this.name = "CircuitOpenError";
  }
}

export class SimulationError extends ArbBotError {
  constructor(
    message: string,
    public readonly poolAddress?: string,
  ) {
    super(message, "SIMULATION_ERROR", true);
    this.name = "SimulationError";
  }
}

export class CalldataError extends ArbBotError {
  constructor(
    message: string,
    public readonly protocol?: string,
  ) {
    super(message, "CALLDATA_ERROR", false);
    this.name = "CalldataError";
  }
}

export class ConfigError extends ArbBotError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", false);
    this.name = "ConfigError";
  }
}

export class ExecutionError extends ArbBotError {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message, "EXECUTION_ERROR", false);
    this.name = "ExecutionError";
  }
}

// ─── Utilities ──────────────────────────────────────────────────

function objectLabel(value: object) {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag && tag !== "Object") return tag;
  const ctor = value.constructor?.name;
  if (ctor && ctor !== "Object") return ctor;
  return null;
}

function displayScalar(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return null;
}

function safeUrlSummary(value: unknown) {
  const url = displayScalar(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.pathname && parsed.pathname !== "/") {
      if (/^\/v2\/[^/]+$/.test(parsed.pathname)) return `${parsed.origin}/v2/[REDACTED]`;
      return `${parsed.origin}/[REDACTED_PATH]`;
    }
    return parsed.origin;
  } catch (err) {
    console.warn("[errors] safeUrlSummary failed:", err);
    return "[redacted-url]";
  }
}

function targetSummary(target: unknown) {
  if (!target || typeof target !== "object") return null;
  const record = target as Record<string, unknown>;
  const ctor = target.constructor?.name;
  const label = ctor && ctor !== "Object" ? ctor : "target";
  const parts = [label];
  const readyState = displayScalar(record.readyState);
  const url = safeUrlSummary(record.url);
  if (readyState != null) parts.push(`readyState=${readyState}`);
  if (url) parts.push(`url=${url}`);
  return parts.join(" ");
}

function objectErrorMessage(err: object) {
  const record = err as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["type", "code", "status", "statusCode", "name"] as const) {
    const value = displayScalar(record[key]);
    if (value) parts.push(`${key}=${value}`);
  }
  const target = targetSummary(record.target);
  if (target) parts.push(`target=${target}`);

  if (parts.length === 0) return null;

  const label = objectLabel(err) ?? (typeof record.type === "string" && record.type ? "ErrorEvent" : "Object");
  return `${label}(${parts.join(" ")})`;
}

export function errorMessage(err: unknown, options: { includeStack?: boolean } = {}) {
  if (err instanceof ArbBotError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) {
    return options.includeStack ? err.stack || err.message : err.message;
  }
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.reason === "string" && record.reason.trim()) return record.reason;
    const summarized = objectErrorMessage(err);
    if (summarized) return summarized;
  }
  return String(err);
}

export function isRecoverable(err: unknown): boolean {
  if (err instanceof ArbBotError) return err.recoverable;
  return true;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
