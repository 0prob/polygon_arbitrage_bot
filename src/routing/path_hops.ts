type PathLike = {
  hopCount?: number;
  edges?: Array<unknown>;
};

export function getPathHopCount(path: PathLike | null | undefined) {
  if (Array.isArray(path?.edges)) return path.edges.length;

  const hopCount = Number(path?.hopCount);
  if (!Number.isSafeInteger(hopCount) || hopCount <= 0) return 0;
  return hopCount;
}

function normalizedHopCount(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function getResultHopCount(result: unknown) {
  const value = result as {
    hopCount?: number;
    poolPath?: Array<unknown>;
    tokenPath?: Array<unknown>;
    hopAmounts?: Array<unknown>;
    amountIn?: unknown;
    amountOut?: unknown;
    profit?: unknown;
    totalGas?: unknown;
  } | null | undefined;

  const structuralCandidates = [
    Array.isArray(value?.poolPath) ? normalizedHopCount(value.poolPath.length) : null,
    Array.isArray(value?.hopAmounts) ? normalizedHopCount(value.hopAmounts.length - 1) : null,
    Array.isArray(value?.tokenPath) ? normalizedHopCount(value.tokenPath.length - 1) : null,
  ].filter((candidate): candidate is number => candidate != null);

  if (structuralCandidates.length > 0) {
    const canonical = structuralCandidates[0];
    for (let i = 1; i < structuralCandidates.length; i++) {
      if (structuralCandidates[i] !== canonical) return 0;
    }
    return canonical;
  }

  return normalizedHopCount(Number(value?.hopCount));
}
