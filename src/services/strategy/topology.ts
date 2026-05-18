import type { Address } from "../../core/types/common.ts";

export interface SerializedPath {
  startToken: Address;
  edges: Array<{ pool: string; tIn: string; tOut: string; fee: string }>;
  hopCount: number;
}

export function loadCachedCycles(_filePath: string, _maxAgeMs: number): SerializedPath[] | null {
  return null;
}

export function saveCachedCycles(_filePath: string, _paths: SerializedPath[]): void {
  // Stub for Phase 3 integration
}
