
/**
 * src/state/pool_record.js — Shared helpers for registry-backed pool records
 */

import { parsePoolMetadataValue, parsePoolTokensValue } from "../utils/pool_record.ts";

export function parsePoolMetadata(metadata: unknown): Record<string, unknown> {
  return parsePoolMetadataValue(metadata);
}

export function parsePoolTokens(tokens: unknown): string[] {
  return parsePoolTokensValue(tokens);
}
