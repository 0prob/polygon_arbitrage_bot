import type { Address } from "../../core/types/common.ts";

export interface HyperSyncLogFilter {
  address?: Address[];
  topics?: string[][];
}

export interface HyperSyncFieldSelection {
  log: string[];
  block: string[];
}

export interface HyperSyncQuery {
  fromBlock: number;
  toBlock?: number;
  logs: HyperSyncLogFilter[];
  fieldSelection: HyperSyncFieldSelection;
  joinMode: unknown;
  maxNumLogs: number;
  maxNumBlocks?: number;
}

export interface HyperSyncClientConfig {
  url: string;
  apiToken: string;
  httpReqTimeoutMillis?: number;
  maxNumRetries?: number;
  retryBackoffMs?: number;
  retryBaseMs?: number;
  retryCeilingMs?: number;
  proactiveRateLimitSleep?: boolean;
}

export interface HyperSyncLog {
  address: string;
  blockNumber: number;
  topics: string[];
  data: string;
  txHash: string;
  logIndex: number;
  txIndex: number;
}

export interface HyperSyncBlockHeader {
  number: number;
  hash: string;
  timestamp: number;
}

export interface StreamProgress {
  pages: number;
  logs: number;
  fromBlock: number;
  nextBlock: number;
  archiveHeight: number | null;
}

export interface StreamConfig {
  concurrency?: number;
  batchSize?: number;
  onProgress?: (progress: StreamProgress) => void;
}

export interface HyperSyncStream<T> {
  recv: () => Promise<HyperSyncGetResponse<T> | null>;
}

export interface HyperSyncGetResponse<TLog = unknown> {
  archiveHeight?: number | string | null;
  nextBlock: number | string;
  data?: { logs?: TLog[] };
}

export interface DecodedLogValue {
  val?: unknown;
}

export interface HypersyncDecodedLog {
  indexed: DecodedLogValue[];
  body: DecodedLogValue[];
}

export interface HypersyncDecoderRuntime {
  decodeLogs: (logs: unknown[]) => Promise<HypersyncDecodedLog[]>;
}

export interface HypersyncClientRuntime {
  getHeight: () => Promise<number>;
  getChainId: () => Promise<number>;
  get: <T = unknown>(query: unknown) => Promise<T>;
  getWithRateLimit: <T = unknown>(query: unknown) => Promise<T>;
  stream: <T = unknown>(query: unknown, config: unknown) => Promise<HyperSyncStream<T>>;
  streamHeight: <T = unknown>() => Promise<T>;
  streamEvents: <T = unknown>(query: unknown, config: unknown) => Promise<T>;
  collect: <T = unknown>(query: unknown, config: unknown) => Promise<T>;
  collectEvents: <T = unknown>(query: unknown, config: unknown) => Promise<T>;
  rateLimitInfo: () => unknown;
  waitForRateLimit: () => Promise<void>;
}
