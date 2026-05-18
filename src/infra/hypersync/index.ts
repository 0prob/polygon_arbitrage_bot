export {
  createHypersyncClient,
  client,
  Decoder,
  LogField,
  BlockField,
  JoinMode,
} from "./client.ts";
export { buildLogQuery, normalizeLogFilter, computeTopic0, computeTopic0s } from "./query.ts";
export { fetchAllLogs } from "./stream.ts";
export type {
  HyperSyncLogFilter,
  HyperSyncQuery,
  HyperSyncClientConfig,
  HyperSyncLog,
  HyperSyncBlockHeader,
  StreamConfig,
  StreamProgress,
  HypersyncClientRuntime,
  HypersyncDecoderRuntime,
  HypersyncDecodedLog,
} from "./types.ts";
