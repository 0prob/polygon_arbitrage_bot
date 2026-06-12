export interface RankingModel {
  version: number;
  weights: Record<string, number>;
  bias: number;
}

export function loadRankingModel(raw: unknown): RankingModel | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as RankingModel;
  if (typeof m.bias !== "number" || typeof m.weights !== "object") return null;
  return m;
}

export function scoreWithModel(features: Record<string, number>, model: RankingModel): number {
  let score = model.bias;
  for (const [k, w] of Object.entries(model.weights)) {
    score += (features[k] ?? 0) * w;
  }
  return score;
}
