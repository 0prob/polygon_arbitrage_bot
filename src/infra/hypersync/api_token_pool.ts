import { readFileSync } from "fs";
import path from "path";

/**
 * Manages a pool of Envio/HyperSync API tokens (all free tier).
 *
 * Goals:
 * - Multiply effective request budget across multiple free keys.
 * - Support "pacing" (local rate limiting) so we never hammer right up to the server limit
 *   and trigger long backoff windows.
 * - Provide rotation for the hyperindex (envio dev) child process restarts when one key gets hot.
 *
 * Discovery order / sources (later sources override duplicates):
 *   1. Explicit tokens passed in constructor
 *   2. ENVIO_API_TOKENS (comma-separated) from process.env
 *   3. ENVIO_API_TOKEN from process.env
 *   4. Tokens parsed from root .env (supports ENVIO_API_TOKEN or ENVIO_API_TOKENS=comma,sep, including commented lines)
 *   5. Tokens parsed from hyperindex/.env (supports both singular and plural forms)
 */

export interface ApiTokenPoolOptions {
  /** Explicit list (highest priority) */
  tokens?: string[];
  /** If true, also scan filesystem .env files for (commented or not) ENVIO_API_TOKEN lines */
  scanEnvFiles?: boolean;
  /** Desired maximum requests per minute *per token* (client-side pacing). 0 or undefined = no local cap. */
  maxRpmPerToken?: number;
  /** Root directory for .env scanning (defaults to process.cwd()) */
  rootDir?: string;
}

export class ApiTokenPool {
  private tokens: string[] = [];
  private index = 0;

  // Simple per-token pacing: last usage timestamp + minimum interval derived from maxRpm.
  private lastUse = new Map<string, number>();
  private minIntervalMs = 0;

  constructor(opts: ApiTokenPoolOptions = {}) {
    const explicit = (opts.tokens ?? []).filter(Boolean);

    let fromEnv: string[] = [];
    const multi = process.env.ENVIO_API_TOKENS;
    if (multi) {
      fromEnv.push(...multi.split(",").map((s) => s.trim()).filter(Boolean));
    }
    const single = process.env.ENVIO_API_TOKEN;
    if (single) fromEnv.push(single.trim());

    let fromFiles: string[] = [];
    if (opts.scanEnvFiles !== false) {
      const root = opts.rootDir ?? process.cwd();
      fromFiles = [
        ...parseEnvTokens(path.join(root, ".env")),
        ...parseEnvTokens(path.join(root, "hyperindex", ".env")),
      ];
    }

    // Deduplicate while preserving order of first appearance
    const seen = new Set<string>();
    for (const t of [...explicit, ...fromEnv, ...fromFiles]) {
      const normalized = t.trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        this.tokens.push(normalized);
      }
    }

    const rpm = opts.maxRpmPerToken ?? 0;
    if (rpm > 0) {
      // e.g. 50 rpm → one request no faster than every 1200ms on average per token
      this.minIntervalMs = Math.ceil(60_000 / rpm);
    }
  }

  hasTokens(): boolean {
    return this.tokens.length > 0;
  }

  count(): number {
    return this.tokens.length;
  }

  /** Current active token (round-robin position) */
  current(): string | undefined {
    return this.tokens[this.index] ?? this.tokens[0];
  }

  /**
   * Get the next token in rotation (advances the pointer).
   * Respects local per-token pacing if maxRpmPerToken was configured.
   */
  next(): string | undefined {
    if (this.tokens.length === 0) return undefined;

    // Try up to N times to find a token that has cooled down locally.
    const n = this.tokens.length;
    for (let i = 0; i < n; i++) {
      const candidate = this.tokens[this.index];
      this.index = (this.index + 1) % this.tokens.length;

      if (this.canUseNow(candidate)) {
        this.recordUse(candidate);
        return candidate;
      }
    }

    // All tokens are still in local cooldown — return the one that will be ready soonest.
    const soonest = this.tokens.reduce((best, t) => {
      const bt = this.lastUse.get(best) ?? 0;
      const tt = this.lastUse.get(t) ?? 0;
      return tt < bt ? t : best;
    }, this.tokens[0]);

    // Still record the use (we're being forced to go early).
    this.recordUse(soonest);
    return soonest;
  }

  /** Mark that we just made a request with this token (for local pacing) */
  recordUse(token: string): void {
    this.lastUse.set(token, Date.now());
  }

  private canUseNow(token: string): boolean {
    if (this.minIntervalMs <= 0) return true;
    const last = this.lastUse.get(token) ?? 0;
    return Date.now() - last >= this.minIntervalMs;
  }

  /** For diagnostics / TUI */
  getStatus() {
    return {
      totalKeys: this.tokens.length,
      current: this.current()?.slice(0, 8) + "…",
      localPacingMs: this.minIntervalMs,
      keys: this.tokens.map((t) => t.slice(0, 8) + "…"),
    };
  }
}

/** Parse a .env file (supports commented lines like #ENVIO_API_TOKEN=xxx or ENVIO_API_TOKENS=comma,separated) */
function parseEnvTokens(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf8");
    const out: string[] = [];
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;

      // Singular: ENVIO_API_TOKEN=xxx (or #ENVIO_API_TOKEN=xxx)
      let m = line.match(/^#?\s*ENVIO_API_TOKEN\s*=\s*['"]?([A-Za-z0-9._-]+)['"]?\s*(?:#.*)?$/);
      if (m && m[1]) {
        out.push(m[1]);
        continue;
      }

      // Plural: ENVIO_API_TOKENS=token1,token2,token3 (or commented)
      // Supports optional quotes around individual tokens or the whole value
      m = line.match(/^#?\s*ENVIO_API_TOKENS\s*=\s*(.+?)\s*(?:#.*)?$/);
      if (m && m[1]) {
        const rawValue = m[1].trim();
        // Strip outer quotes if present on the entire value
        const value = rawValue.replace(/^['"](.*)['"]$/, "$1");
        for (const part of value.split(",")) {
          const t = part.trim().replace(/^['"](.*)['"]$/, "$1").trim();
          if (t) out.push(t);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Convenience factory used by most call sites */
export function createDefaultApiTokenPool(maxRpmPerToken?: number): ApiTokenPool {
  return new ApiTokenPool({
    scanEnvFiles: true,
    maxRpmPerToken,
  });
}
