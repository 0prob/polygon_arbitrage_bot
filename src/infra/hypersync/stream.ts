import type { HypersyncClientRuntime, HyperSyncQuery, HyperSyncGetResponse, StreamConfig } from "./types.ts";

const MAX_ACCUMULATED_LOGS = 200_000;
const MAX_PAGES = 10_000;

function parseBlock(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`HyperSync ${name} must be a non-negative safe integer`);
  }
  return n;
}

function parseOptionalBlock(value: unknown, name: string): number | null {
  if (value == null) return null;
  return parseBlock(value, name);
}

function pageLogsFromResponse<TLog>(res: HyperSyncGetResponse<TLog>): TLog[] {
  const logs = res.data?.logs;
  if (logs == null) return [];
  if (!Array.isArray(logs)) {
    throw new Error("HyperSync response data.logs must be an array");
  }
  return logs;
}

function fireProgress<TLog>(config: StreamConfig, pages: number, allLogs: TLog[], nextBlock: number, archiveHeight: number | null) {
  config.onProgress?.({
    pages,
    logs: allLogs.length,
    fromBlock: nextBlock,
    nextBlock,
    archiveHeight,
  });
}

export type FetchAllLogsResult<TLog> = {
  logs: TLog[];
  archiveHeight: number | null;
  nextBlock: number | null;
  pages: number;
};

export async function fetchAllLogs<TLog = unknown>(
  client: HypersyncClientRuntime,
  query: HyperSyncQuery,
  config: StreamConfig = {},
): Promise<FetchAllLogsResult<TLog>> {
  const initialFromBlock = parseBlock(query.fromBlock, "query.fromBlock");
  const initialToBlock = parseOptionalBlock(query.toBlock, "query.toBlock");

  if (initialToBlock != null && initialToBlock < initialFromBlock) {
    throw new Error(`HyperSync query has invalid block range: fromBlock ${initialFromBlock} exceeds toBlock ${initialToBlock}`);
  }

  if (initialToBlock != null && initialToBlock === initialFromBlock) {
    return { logs: [], archiveHeight: null, nextBlock: initialFromBlock, pages: 0 };
  }

  const allLogs: TLog[] = [];
  const currentQuery = { ...query };
  let archiveHeight: number | null = null;
  let lastNextBlock: number | null = null;
  let pages = 0;
  const { concurrency = 10, batchSize = 1000 } = config;

  const clientRecord = client as unknown as Record<string, unknown>;
  if (typeof clientRecord.stream === "function") {
    const stream = await (clientRecord.stream as (q: unknown, opts: unknown) => Promise<unknown>)(currentQuery, { concurrency, batchSize });
    const typedStream = stream as { recv: () => Promise<HyperSyncGetResponse<TLog> | null> };

    while (true) {
      if (pages >= MAX_PAGES) {
        throw new Error(`HyperSync pagination exceeded maxPages ${MAX_PAGES}`);
      }

      const res: HyperSyncGetResponse<TLog> | null = await typedStream.recv();
      if (res === null) break;

      pages++;

      if (res.archiveHeight != null) {
        archiveHeight = parseBlock(res.archiveHeight, "response archiveHeight");
      }

      const pageLogs = pageLogsFromResponse(res);
      if (pageLogs.length > 0) {
        if (allLogs.length + pageLogs.length > MAX_ACCUMULATED_LOGS) {
          throw new Error(`HyperSync exceeded memory limit of ${MAX_ACCUMULATED_LOGS} logs (${allLogs.length} + ${pageLogs.length})`);
        }
        for (const log of pageLogs) {
          allLogs.push(log);
        }
      }

      const responseNextBlock = parseBlock(res.nextBlock, "response nextBlock");
      lastNextBlock = responseNextBlock;

      fireProgress(config, pages, allLogs, responseNextBlock, archiveHeight);

      const targetEnd = initialToBlock ?? archiveHeight;
      if (targetEnd != null && lastNextBlock >= targetEnd) break;
    }
  } else {
    while (true) {
      if (pages >= MAX_PAGES) {
        throw new Error(`HyperSync pagination exceeded maxPages ${MAX_PAGES}`);
      }

      const res: HyperSyncGetResponse<TLog> = await client.get(currentQuery);
      pages++;

      if (res.archiveHeight != null) {
        archiveHeight = parseBlock(res.archiveHeight, "response archiveHeight");
      }

      const pageLogs = pageLogsFromResponse(res);
      if (pageLogs.length > 0) {
        if (allLogs.length + pageLogs.length > MAX_ACCUMULATED_LOGS) {
          throw new Error(`HyperSync exceeded memory limit of ${MAX_ACCUMULATED_LOGS} logs`);
        }
        for (const log of pageLogs) {
          allLogs.push(log);
        }
      }

      const responseNextBlock = parseBlock(res.nextBlock, "response nextBlock");
      lastNextBlock = responseNextBlock;

      fireProgress(config, pages, allLogs, responseNextBlock, archiveHeight);

      const targetEnd = initialToBlock ?? archiveHeight;
      if (targetEnd != null && lastNextBlock != null) {
        if (lastNextBlock >= targetEnd) break;
        if (lastNextBlock === currentQuery.fromBlock) break;
      }

      if (lastNextBlock == null) break;

      currentQuery.fromBlock = responseNextBlock;
    }
  }

  return {
    logs: allLogs,
    archiveHeight,
    nextBlock: lastNextBlock,
    pages,
  };
}
