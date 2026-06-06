export interface ExecutionRecord {
  routeKey: string;
  txHash: string;
  success: boolean;
  gasUsed: bigint;
  profit: bigint;
  timestamp: number;
  error?: string;
  pools: string[];
}

export interface RouteStats {
  totalAttempts: number;
  totalSuccesses: number;
  totalReverts: number;
  totalProfit: bigint;
  lastSeen: number;
  winRate: number;
}

export class ExecutionTracker {
  private records: ExecutionRecord[] = [];
  private routeStats = new Map<string, RouteStats>();
  private readonly maxRecords: number;

  constructor(maxRecords = 10_000) {
    this.maxRecords = maxRecords;
  }

  record(entry: ExecutionRecord): void {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      const removed = this.records.shift()!;
      const stats = this.routeStats.get(removed.routeKey);
      if (stats) {
        stats.totalAttempts--;
        if (removed.success) stats.totalSuccesses--;
        else stats.totalReverts--;
        stats.totalProfit -= removed.profit;
        if (stats.totalAttempts <= 0) this.routeStats.delete(removed.routeKey);
      }
    }

    let stats = this.routeStats.get(entry.routeKey);
    if (!stats) {
      stats = { totalAttempts: 0, totalSuccesses: 0, totalReverts: 0, totalProfit: 0n, lastSeen: 0, winRate: 0 };
      this.routeStats.set(entry.routeKey, stats);
    }
    stats.totalAttempts++;
    if (entry.success) stats.totalSuccesses++;
    else stats.totalReverts++;
    stats.totalProfit += entry.profit;
    stats.lastSeen = entry.timestamp;
    stats.winRate = stats.totalAttempts > 0 ? stats.totalSuccesses / stats.totalAttempts : 0;
  }

  getRouteStats(routeKey: string): RouteStats | undefined {
    return this.routeStats.get(routeKey);
  }

  getWinRate(routeKey: string): number {
    return this.routeStats.get(routeKey)?.winRate ?? 0;
  }

  getAllRouteStats(): ReadonlyMap<string, RouteStats> {
    return this.routeStats;
  }

  getRecentRecords(count: number): ExecutionRecord[] {
    return this.records.slice(-count);
  }

  get summary(): { totalAttempts: number; totalSuccesses: number; totalReverts: number; totalProfit: bigint; trackedRoutes: number } {
    let totalAttempts = 0;
    let totalSuccesses = 0;
    let totalReverts = 0;
    let totalProfit = 0n;
    for (const s of this.routeStats.values()) {
      totalAttempts += s.totalAttempts;
      totalSuccesses += s.totalSuccesses;
      totalReverts += s.totalReverts;
      totalProfit += s.totalProfit;
    }
    return { totalAttempts, totalSuccesses, totalReverts, totalProfit, trackedRoutes: this.routeStats.size };
  }

  prune(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    const before = this.records.length;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);
    const removed = before - this.records.length;

    if (removed > 0) {
      this.routeStats.clear();
      for (const entry of this.records) {
        let stats = this.routeStats.get(entry.routeKey);
        if (!stats) {
          stats = { totalAttempts: 0, totalSuccesses: 0, totalReverts: 0, totalProfit: 0n, lastSeen: 0, winRate: 0 };
          this.routeStats.set(entry.routeKey, stats);
        }
        stats.totalAttempts++;
        if (entry.success) stats.totalSuccesses++;
        else stats.totalReverts++;
        stats.totalProfit += entry.profit;
        stats.lastSeen = entry.timestamp;
        stats.winRate = stats.totalAttempts > 0 ? stats.totalSuccesses / stats.totalAttempts : 0;
      }
    }
  }
}
