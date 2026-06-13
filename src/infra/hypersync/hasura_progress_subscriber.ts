import type { Logger } from "../observability/logger.ts";
import type { IndexerProgress } from "./hyperindex_graphql.ts";
import {
  fetchIndexerMetaFromHasura,
  fetchIndexerProgressFromHasura,
} from "./hyperindex_graphql.ts";

const PROGRESS_SUBSCRIPTION = `
subscription IndexerProgressUpdates($chainId: Int!) {
  IndexerProgress(where: { chainId: { _eq: $chainId } }) {
    chainId
    lastProcessedBlock
    updatedAtBlock
  }
}
`;

const META_SUBSCRIPTION = `
subscription IndexerMetaUpdates($chainId: Int!) {
  _meta(where: { chainId: { _eq: $chainId } }) {
    chainId
    progressBlock
    sourceBlock
    isReady
  }
}
`;

function httpToWs(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice(8)}`;
  if (url.startsWith("http://")) return `ws://${url.slice(7)}`;
  return url;
}

export type ProgressCallback = (progress: IndexerProgress) => void;

export interface HasuraProgressSubscriberOptions {
  graphqlUrl: string;
  adminSecret: string;
  chainId: number;
  logger?: Pick<Logger, "info" | "warn" | "debug">;
  execute?: <T>(fn: () => Promise<T>) => Promise<T>;
  fallbackPollMs?: number;
}

/** Live Hasura subscriptions for IndexerProgress + Envio _meta; HTTP fallback when WS is unavailable. */
export class HasuraProgressSubscriber {
  private ws: WebSocket | null = null;
  private readonly progressSubscriptionId = "indexer-progress";
  private readonly metaSubscriptionId = "indexer-meta";
  private onProgress: ProgressCallback | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastSourceBlock: number | undefined;
  private wsConnected = false;

  constructor(private readonly opts: HasuraProgressSubscriberOptions) {}

  setProgressHandler(cb: ProgressCallback): void {
    this.onProgress = cb;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.seedProgress();
    await this.seedMeta();
    this.connectWebSocket();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.reconnectTimer = null;
    this.fallbackTimer = null;
    this.wsConnected = false;
    this.closeWebSocket();
  }

  private async seedProgress(): Promise<void> {
    try {
      const exec = this.opts.execute ?? ((fn) => fn());
      const progress = await exec(() =>
        fetchIndexerProgressFromHasura(
          this.opts.graphqlUrl,
          this.opts.adminSecret,
          this.opts.logger,
          this.opts.chainId,
        ),
      );
      if (progress) this.emitProgress(progress);
    } catch (err) {
      this.opts.logger?.warn?.({ err }, "Initial indexer progress fetch failed");
    }
  }

  private async seedMeta(): Promise<void> {
    try {
      const exec = this.opts.execute ?? ((fn) => fn());
      const meta = await exec(() =>
        fetchIndexerMetaFromHasura(
          this.opts.graphqlUrl,
          this.opts.adminSecret,
          this.opts.chainId,
          this.opts.logger,
        ),
      );
      if (meta?.sourceBlock !== undefined) {
        this.lastSourceBlock = meta.sourceBlock;
      }
      if (meta) {
        this.emitProgress(meta);
      }
    } catch {
      // non-fatal — entity subscription still drives progressBlock
    }
  }

  private emitProgress(progress: IndexerProgress): void {
    this.onProgress?.({
      ...progress,
      sourceBlock: progress.sourceBlock ?? this.lastSourceBlock,
    });
  }

  private connectWebSocket(): void {
    if (this.stopped) return;
    const wsUrl = httpToWs(this.opts.graphqlUrl);

    try {
      const ws = new WebSocket(wsUrl, ["graphql-transport-ws", "graphql-ws"]);
      this.ws = ws;

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "connection_init",
            payload: {
              headers: { "x-hasura-admin-secret": this.opts.adminSecret },
            },
          }),
        );
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(String(event.data));
      });

      ws.addEventListener("error", () => {
        this.opts.logger?.debug?.("Hasura progress WebSocket error");
      });

      ws.addEventListener("close", () => {
        this.ws = null;
        this.wsConnected = false;
        if (!this.stopped) {
          this.startFallbackPolling();
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      this.opts.logger?.warn?.({ err }, "Hasura progress WebSocket connect failed");
      this.startFallbackPolling();
      this.scheduleReconnect();
    }
  }

  private subscribeAll(): void {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        type: "subscribe",
        id: this.progressSubscriptionId,
        payload: {
          query: PROGRESS_SUBSCRIPTION,
          variables: { chainId: this.opts.chainId },
        },
      }),
    );
    this.ws.send(
      JSON.stringify({
        type: "subscribe",
        id: this.metaSubscriptionId,
        payload: {
          query: META_SUBSCRIPTION,
          variables: { chainId: this.opts.chainId },
        },
      }),
    );
  }

  private handleMessage(raw: string): void {
    let msg: { type: string; id?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }

    switch (msg.type) {
      case "connection_ack":
        this.wsConnected = true;
        this.stopFallbackPolling();
        this.subscribeAll();
        break;
      case "next":
        if (msg.id === this.progressSubscriptionId) {
          this.handleProgressSubscriptionData(msg.payload);
        } else if (msg.id === this.metaSubscriptionId) {
          this.handleMetaSubscriptionData(msg.payload);
        }
        break;
      case "error":
        this.opts.logger?.warn?.({ payload: msg.payload }, "Hasura progress subscription error");
        this.startFallbackPolling();
        break;
      default:
        break;
    }
  }

  private handleProgressSubscriptionData(payload: unknown): void {
    const data = payload as {
      data?: {
        IndexerProgress?: Array<{
          chainId: number;
          lastProcessedBlock: number;
          updatedAtBlock: number;
        }>;
      };
    };
    const rows = data?.data?.IndexerProgress ?? [];
    const row = rows.find((r) => r.chainId === this.opts.chainId) ?? rows[0];
    if (!row) return;
    this.emitProgress({
      chainId: row.chainId,
      lastProcessedBlock: row.lastProcessedBlock,
      updatedAtBlock: row.updatedAtBlock,
    });
  }

  private handleMetaSubscriptionData(payload: unknown): void {
    const data = payload as {
      data?: {
        _meta?: Array<{
          chainId: number;
          progressBlock: number;
          sourceBlock?: number;
          isReady?: boolean;
        }>;
      };
    };
    const rows = data?.data?._meta ?? [];
    const row = rows.find((r) => r.chainId === this.opts.chainId) ?? rows[0];
    if (!row || row.progressBlock <= 0) return;
    if (row.sourceBlock !== undefined) {
      this.lastSourceBlock = row.sourceBlock;
    }
    this.emitProgress({
      chainId: row.chainId,
      lastProcessedBlock: row.progressBlock,
      updatedAtBlock: row.progressBlock,
      sourceBlock: row.sourceBlock,
      isReady: row.isReady,
    });
  }

  private closeWebSocket(): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify({ type: "complete", id: this.progressSubscriptionId }));
      this.ws.send(JSON.stringify({ type: "complete", id: this.metaSubscriptionId }));
      this.ws.close();
    } catch {
      // ignore close races
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connectWebSocket();
    }, 10_000);
  }

  private startFallbackPolling(): void {
    if (this.fallbackTimer) return;
    const ms = this.opts.fallbackPollMs ?? 30_000;
    this.fallbackTimer = setInterval(() => {
      void this.seedProgress();
      void this.seedMeta();
    }, ms);
  }

  private stopFallbackPolling(): void {
    if (!this.fallbackTimer) return;
    clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
  }
}
