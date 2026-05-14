import { lowerCaseAddressList, mapArbHistoryRow } from "./registry_codec.ts";
import type { CompatDatabase } from "./sqlite.ts";

type HistoryDatabase = Pick<CompatDatabase, "statement">;

type ArbResultInput = {
  txHash?: unknown;
  blockNumber?: unknown;
  startToken?: unknown;
  hopCount?: unknown;
  amountIn?: unknown;
  amountOut?: unknown;
  grossProfit?: unknown;
  netProfit?: unknown;
  gasUsed?: unknown;
  gasPriceWei?: unknown;
  pools?: unknown;
  protocols?: unknown;
  status?: unknown;
};

export type ArbHistoryOptions = {
  limit?: unknown;
  startToken?: unknown;
  status?: unknown;
  since?: unknown;
};

type ArbStatsTotalsRow = {
  total?: unknown;
  successes?: unknown;
  reverts?: unknown;
  dropped?: unknown;
};

type ArbStatsByHopRow = {
  hop_count?: unknown;
  count?: unknown;
};

function historyStmt(db: HistoryDatabase, key: string, sql: string) {
  return db.statement(key, sql);
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`Arbitrage history ${label} must be a string`);
  }
  return value;
}

function normalizeOptionalText(value: unknown) {
  return value == null ? null : String(value);
}

function normalizeOptionalNumber(value: unknown) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeHistoryLimit(value: unknown) {
  if (value == null || value === "") return 100;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
}

function normalizeCount(value: unknown) {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export function logArbResult(db: HistoryDatabase, arb: ArbResultInput) {
  const startToken = requireString(arb.startToken, "startToken").toLowerCase();
  const pools = Array.isArray(arb.pools) ? arb.pools : [];
  const protocols = Array.isArray(arb.protocols) ? arb.protocols : [];

  historyStmt(
    db,
    "logArbResult",
    `INSERT INTO arb_history
         (tx_hash, block_number, start_token, hop_count,
          amount_in, amount_out, gross_profit, net_profit,
          gas_used, gas_price_wei, pools, protocols, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    normalizeOptionalText(arb.txHash),
    normalizeOptionalNumber(arb.blockNumber),
    startToken,
    normalizeOptionalNumber(arb.hopCount),
    arb.amountIn != null ? String(arb.amountIn) : null,
    arb.amountOut != null ? String(arb.amountOut) : null,
    arb.grossProfit != null ? String(arb.grossProfit) : null,
    arb.netProfit != null ? String(arb.netProfit) : null,
    normalizeOptionalNumber(arb.gasUsed),
    arb.gasPriceWei != null ? String(arb.gasPriceWei) : null,
    JSON.stringify(lowerCaseAddressList(pools)),
    JSON.stringify(protocols),
    normalizeOptionalText(arb.status) ?? "success",
  );
}

export function getArbHistory(db: HistoryDatabase, opts: ArbHistoryOptions = {}) {
  const { startToken, status, since } = opts;
  const limit = normalizeHistoryLimit(opts.limit);
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (startToken) {
    conditions.push("start_token = ?");
    params.push(String(startToken).toLowerCase());
  }
  if (status) {
    conditions.push("status = ?");
    params.push(String(status));
  }
  if (since) {
    conditions.push("recorded_at >= ?");
    params.push(String(since));
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const rows = historyStmt(
    db,
    `getArbHistory:${where}`,
    `SELECT id, tx_hash, block_number, start_token, hop_count,
            amount_in, amount_out, gross_profit, net_profit,
            gas_used, gas_price_wei, pools, protocols, status, recorded_at
     FROM arb_history ${where} ORDER BY recorded_at DESC LIMIT ?`,
  ).all(...params, limit);

  return rows.map((row) => mapArbHistoryRow(row));
}

export function getArbStats(db: HistoryDatabase, opts: ArbHistoryOptions = {}) {
  const { since } = opts;
  const whereClause = since ? "WHERE recorded_at >= ?" : "";
  const params = since ? [String(since)] : [];

  const totals = historyStmt(
    db,
    `getArbStatsTotals:${whereClause}`,
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
       SUM(CASE WHEN status = 'reverted' THEN 1 ELSE 0 END) as reverts,
       SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) as dropped
     FROM arb_history ${whereClause}`,
  ).get(...params) as ArbStatsTotalsRow | undefined;

  // Load net_profit as TEXT and aggregate in JS with BigInt to avoid CAST-to-REAL precision loss
  const profitWhere = since ? "AND recorded_at >= ?" : "";
  const profitRows = historyStmt(
    db,
    `getArbStatsProfitRows:${profitWhere}`,
    `SELECT net_profit FROM arb_history WHERE status = 'success' ${profitWhere}`,
  ).all(...(since ? [String(since)] : [])) as { net_profit: string }[];

  let totalNetProfit = 0n;
  let maxNetProfit: bigint | null = null;
  let profitCount = 0;
  for (const row of profitRows) {
    try {
      const val = BigInt(row.net_profit);
      totalNetProfit += val;
      if (maxNetProfit == null || val > maxNetProfit) maxNetProfit = val;
      profitCount++;
    } catch {
      // skip malformed values
    }
  }

  const byHop = historyStmt(
    db,
    `getArbStatsByHop:${whereClause}`,
    `SELECT hop_count, COUNT(*) as count
     FROM arb_history ${whereClause}
     GROUP BY hop_count`,
  ).all(...params) as ArbStatsByHopRow[];

  const byHopMap: Record<string, number> = {};
  for (const row of byHop) byHopMap[String(row.hop_count)] = normalizeCount(row.count);

  return {
    total: normalizeCount(totals?.total),
    successes: normalizeCount(totals?.successes),
    reverts: normalizeCount(totals?.reverts),
    dropped: normalizeCount(totals?.dropped),
    totalNetProfit: totalNetProfit.toString(),
    avgNetProfit: profitCount > 0 ? (totalNetProfit / BigInt(profitCount)).toString() : "0",
    maxNetProfit: maxNetProfit?.toString() ?? "0",
    byHopCount: byHopMap,
  };
}
