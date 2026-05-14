import fs from "node:fs";
import path from "node:path";

import { toFiniteNumber as normaliseLogWeight } from "../utils/bigint.ts";
import { routeIdentityFromSerializedPath } from "../routing/route_identity.ts";
import type { SerializedEnumeratedPath, SerializedTopology } from "../routing/worker_messages.ts";

export type SerializedPathLike = SerializedEnumeratedPath;

export type ArbPathLike = {
  startToken: string;
  edges: Array<{
    poolAddress: string;
    tokenIn: string;
    tokenOut: string;
    protocol: string;
    zeroForOne: boolean;
  }>;
  hopCount: number;
  logWeight: unknown;
  cumulativeFeesBps?: number;
};

type PersistentRouteCycleCache = {
  version: 1;
  cacheKey: string;
  writtenAt: number;
  paths: SerializedPathLike[];
};
type EdgeLookupGraph = {
  getPoolEdge: (poolAddress: string, tokenIn: string, tokenOut: string) => ArbPathLike["edges"][number] | null | undefined;
};

function normalizeMaxAgeMs(value: unknown) {
  if (value == null) return Number.POSITIVE_INFINITY;
  const maxAgeMs = Number(value);
  return Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : Number.POSITIVE_INFINITY;
}

function normalizeSerializedPath(serialised: SerializedPathLike | null | undefined) {
  if (typeof serialised?.startToken !== "string") return null;
  const startToken = serialised.startToken.trim().toLowerCase();
  if (!startToken) return null;
  if (!Array.isArray(serialised.poolAddresses)) return null;
  if (!Array.isArray(serialised.tokenIns)) return null;
  if (!Array.isArray(serialised.tokenOuts)) return null;
  if (serialised.zeroForOnes != null && !Array.isArray(serialised.zeroForOnes)) return null;

  const expectedHops = serialised.poolAddresses.length;
  if (
    serialised.tokenIns.length !== expectedHops ||
    serialised.tokenOuts.length !== expectedHops ||
    (serialised.zeroForOnes != null && serialised.zeroForOnes.length !== expectedHops) ||
    expectedHops === 0
  ) {
    return null;
  }

  const poolAddresses: string[] = [];
  const tokenIns: string[] = [];
  const tokenOuts: string[] = [];
  const zeroForOnes = serialised.zeroForOnes ?? [];

  for (let i = 0; i < expectedHops; i++) {
    const poolAddress = serialised.poolAddresses[i];
    const tokenIn = serialised.tokenIns[i];
    const tokenOut = serialised.tokenOuts[i];
    const zeroForOne = zeroForOnes[i];
    if (typeof poolAddress !== "string" || typeof tokenIn !== "string" || typeof tokenOut !== "string") {
      return null;
    }
    const normalizedPool = poolAddress.trim().toLowerCase();
    const normalizedTokenIn = tokenIn.trim().toLowerCase();
    const normalizedTokenOut = tokenOut.trim().toLowerCase();
    if (!normalizedPool || !normalizedTokenIn || !normalizedTokenOut) return null;
    if (serialised.zeroForOnes != null && typeof zeroForOne !== "boolean") return null;
    poolAddresses.push(normalizedPool);
    tokenIns.push(normalizedTokenIn);
    tokenOuts.push(normalizedTokenOut);
  }

  if (tokenIns[0] !== startToken) return null;
  if (tokenOuts[tokenOuts.length - 1] !== startToken) return null;

  return {
    startToken,
    poolAddresses,
    tokenIns,
    tokenOuts,
    zeroForOnes: serialised.zeroForOnes == null ? null : zeroForOnes,
    logWeight: serialised.logWeight,
    cumulativeFeesBps: serialised.cumulativeFeesBps,
  };
}

export function createTopologyCache(maxTotalPaths: number) {
  let cachedHubTopology: SerializedTopology | null = null;
  let cachedFullTopology: SerializedTopology | null = null;
  let cachedHubTopologyGraph: object | null = null;
  let cachedFullTopologyGraph: object | null = null;

  function invalidateSerializedTopologies() {
    cachedHubTopology = null;
    cachedFullTopology = null;
    cachedHubTopologyGraph = null;
    cachedFullTopologyGraph = null;
  }

  function getSerializedTopologyCached<TGraph extends object>(
    kind: "hub" | "full",
    graph: TGraph,
    serializeTopology: (graph: TGraph) => SerializedTopology,
  ) {
    if (kind === "hub") {
      if (cachedHubTopologyGraph !== graph || !cachedHubTopology) {
        cachedHubTopology = serializeTopology(graph);
        cachedHubTopologyGraph = graph;
      }
      return cachedHubTopology;
    }

    if (cachedFullTopologyGraph !== graph || !cachedFullTopology) {
      cachedFullTopology = serializeTopology(graph);
      cachedFullTopologyGraph = graph;
    }
    return cachedFullTopology;
  }

  function hydratePaths(
    serialised: SerializedPathLike[],
    hub: EdgeLookupGraph,
    full: EdgeLookupGraph,
    options: { maxPaths?: number | null } = {},
  ) {
    return hydratePathCache(serialised, hub, full, options).paths;
  }

  function hydratePathCache(
    serialised: SerializedPathLike[],
    hub: EdgeLookupGraph,
    full: EdgeLookupGraph,
    options: { maxPaths?: number | null } = {},
  ) {
    const paths: ArbPathLike[] = [];
    const seen = new Set<string>();
    let accepted = 0;
    let rejected = 0;

    for (const raw of serialised) {
      const s = normalizeSerializedPath(raw);
      if (!s) {
        rejected++;
        continue;
      }

      const key = routeIdentityFromSerializedPath(s.startToken, s.poolAddresses, s.tokenIns, s.tokenOuts);
      if (seen.has(key)) continue;
      seen.add(key);

      const edges: ArbPathLike["edges"] = [];
      let ok = true;
      for (let i = 0; i < s.poolAddresses.length; i++) {
        const pool = s.poolAddresses[i];
        const tokenIn = s.tokenIns[i];
        const tokenOut = s.tokenOuts[i];
        const candidate = hub.getPoolEdge(pool, tokenIn, tokenOut) || full.getPoolEdge(pool, tokenIn, tokenOut);
        if (!candidate || (s.zeroForOnes != null && candidate.zeroForOne !== s.zeroForOnes[i])) {
          ok = false;
          break;
        }
        edges.push(candidate);
      }

      if (ok && edges.length === s.poolAddresses.length) {
        accepted++;
        paths.push({
          startToken: s.startToken,
          edges,
          hopCount: edges.length,
          logWeight: s.logWeight,
          cumulativeFeesBps: s.cumulativeFeesBps,
        });
      } else {
        rejected++;
      }
    }

    paths.sort((a, b) => normaliseLogWeight(a.logWeight) - normaliseLogWeight(b.logWeight));
    const maxPaths = options.maxPaths === undefined ? maxTotalPaths : options.maxPaths;
    const limitedPaths = maxPaths == null ? paths : paths.slice(0, Math.max(0, maxPaths));
    return {
      paths: limitedPaths,
      accepted,
      rejected,
      total: serialised.length,
    };
  }

  function serializePaths(paths: ArbPathLike[]): SerializedPathLike[] {
    return paths.map((path) => ({
      startToken: path.startToken,
      poolAddresses: path.edges.map((edge) => edge.poolAddress),
      tokenIns: path.edges.map((edge) => edge.tokenIn),
      tokenOuts: path.edges.map((edge) => edge.tokenOut),
      zeroForOnes: path.edges.map((edge) => edge.zeroForOne),
      hopCount: path.hopCount,
      logWeight: typeof path.logWeight === "bigint" ? path.logWeight.toString() : path.logWeight,
      cumulativeFeesBps: path.cumulativeFeesBps,
    }));
  }

  function readPersistentRouteCycles(cacheFile: string | null | undefined, cacheKey: string, maxAgeMs?: number) {
    if (!cacheFile) return { hit: false, paths: [] as SerializedPathLike[], reason: "disabled" };
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as PersistentRouteCycleCache;
      if (parsed?.version !== 1 || parsed.cacheKey !== cacheKey || !Array.isArray(parsed.paths)) {
        return { hit: false, paths: [] as SerializedPathLike[], reason: "mismatch" };
      }
      const writtenAt = Number(parsed.writtenAt);
      const normalizedMaxAgeMs = normalizeMaxAgeMs(maxAgeMs);
      if (!Number.isFinite(writtenAt) || writtenAt <= 0) {
        return { hit: false, paths: [] as SerializedPathLike[], reason: "missing_written_at" };
      }
      const ageMs = Date.now() - writtenAt;
      if (ageMs < 0 || ageMs > normalizedMaxAgeMs) {
        return { hit: false, paths: [] as SerializedPathLike[], reason: "expired", ageMs };
      }
      return { hit: true, paths: parsed.paths, reason: "hit", ageMs };
    } catch {
      return { hit: false, paths: [] as SerializedPathLike[], reason: "unreadable" };
    }
  }

  function writePersistentRouteCycles(cacheFile: string | null | undefined, cacheKey: string, paths: ArbPathLike[]) {
    if (!cacheFile) return false;
    if (paths.length === 0) return false;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      const payload: PersistentRouteCycleCache = {
        version: 1,
        cacheKey,
        writtenAt: Date.now(),
        paths: serializePaths(paths),
      };
      fs.writeFileSync(tempFile, `${JSON.stringify(payload)}\n`);
      fs.renameSync(tempFile, cacheFile);
      return true;
    } catch {
      return false;
    }
  }

  return {
    getSerializedTopologyCached,
    hydratePathCache,
    hydratePaths,
    invalidateSerializedTopologies,
    readPersistentRouteCycles,
    writePersistentRouteCycles,
  };
}
