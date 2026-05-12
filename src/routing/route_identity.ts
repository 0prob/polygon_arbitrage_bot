import { normalizeEvmAddress } from "../utils/identity.ts";

export type RouteIdentityEdge = {
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
};

function requireRouteAddress(value: unknown, label: string) {
  const normalized = normalizeEvmAddress(value);
  if (!normalized) throw new Error(`route identity: valid ${label} required`);
  return normalized;
}

function normaliseRouteSegment(poolAddress: unknown, tokenIn: unknown, tokenOut: unknown) {
  return [
    requireRouteAddress(poolAddress, "poolAddress"),
    requireRouteAddress(tokenIn, "tokenIn"),
    requireRouteAddress(tokenOut, "tokenOut"),
  ].join(":");
}

export function routeIdentityFromEdges(startToken: string, edges: RouteIdentityEdge[]) {
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error("route identity: edges must be non-empty");
  }
  return [
    requireRouteAddress(startToken, "startToken"),
    ...edges.map((edge) => normaliseRouteSegment(edge.poolAddress, edge.tokenIn, edge.tokenOut)),
  ].join("|");
}

export function routeIdentityFromSerializedPath(
  startToken: string,
  poolAddresses: string[],
  tokenIns: string[],
  tokenOuts: string[],
) {
  if (
    !Array.isArray(poolAddresses) ||
    !Array.isArray(tokenIns) ||
    !Array.isArray(tokenOuts) ||
    poolAddresses.length === 0 ||
    tokenIns.length !== poolAddresses.length ||
    tokenOuts.length !== poolAddresses.length
  ) {
    throw new Error("route identity: serialized path segment length mismatch");
  }

  return [
    requireRouteAddress(startToken, "startToken"),
    ...poolAddresses.map((poolAddress, index) =>
      normaliseRouteSegment(poolAddress, tokenIns[index], tokenOuts[index])
    ),
  ].join("|");
}

export function routeExecutionCacheKey(startToken: string, hopCount: number, edges: RouteIdentityEdge[]) {
  const normalizedHopCount = Number(hopCount);
  if (!Number.isSafeInteger(normalizedHopCount) || normalizedHopCount <= 0) {
    throw new Error("route identity: hopCount must be a positive integer");
  }
  if (Array.isArray(edges) && edges.length !== normalizedHopCount) {
    throw new Error("route identity: hopCount must match edges length");
  }
  return `arb:${normalizedHopCount}:${routeIdentityFromEdges(startToken, edges)}`;
}
