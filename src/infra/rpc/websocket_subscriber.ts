export interface NewHeadEvent {
  type: "newHead";
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  timestamp: number;
}

export interface NewPendingTxEvent {
  type: "newPendingTx";
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
}

export interface NewLogEvent {
  type: "newLog";
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type WsEvent = NewHeadEvent | NewPendingTxEvent | NewLogEvent | ErrorEvent;

export type WsEventHandler = (event: WsEvent) => void;

export interface WebSocketSubscriberOptions {
  url: string;
  maxPendingTxsPerTick?: number;
  reconnectDelayMs?: number;
  pingIntervalMs?: number;
}

export class WebSocketSubscriber {
  private ws: WebSocket | null = null;
  private eventHandlers: WsEventHandler[] = [];
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private requestId = 0;

  // Throttling for eth_getTransactionByHash to avoid RPC rate limits
  private pendingTxQueue: string[] = [];
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private WORKER_INTERVAL_MS = 100;
  private MAX_BATCH_SIZE = 5;

  constructor(private options: WebSocketSubscriberOptions) {}

  onEvent(handler: WsEventHandler): void {
    this.eventHandlers.push(handler);
  }

  removeHandler(handler: WsEventHandler): void {
    this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.connect();

    // Start background worker for throttled TX fetching
    this.workerTimer = setInterval(() => this.processTxQueue(), this.WORKER_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (!this.running) return;
    try {
      this.ws = new WebSocket(this.options.url);
      this.reconnectAttempts = 0;
      this.ws.onopen = () => {
        // Only subscribe to real updates, don't emit dummy block 0.
        this.subscribeNewHeads();
        this.subscribePendingTransactions();
        this.pingTimer = setInterval(() => this.ping(), this.options.pingIntervalMs ?? 15_000);
      };

      this.ws.onmessage = (msg: MessageEvent) => {
        try {
          if (typeof msg.data !== "string") return;
          const data = JSON.parse(msg.data) as Record<string, unknown>;

          if (data.error) {
            this.emit({ type: "error", message: JSON.stringify(data.error) });
            return;
          }

          if (typeof data.id === "number" && data.result !== undefined) {
            this.handleRpcResponse(data as { id: number; result: unknown });
          }
        } catch (err) {
          /* skip malformed */
        }
      };

      this.ws.onclose = () => {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        this.scheduleReconnect();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectAttempts >= 10) {
      console.warn(`WebSocket reconnect limit reached after ${this.reconnectAttempts} attempts, giving up`);
      return;
    }
    const base = this.options.reconnectDelayMs ?? 5_000;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private ping(): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: this.requestId++ }));
      }
    } catch {
      /* ignore */
    }
  }

  private subscribeNewHeads(): void {
    this.sendSubscription<Record<string, string>>("newHeads", (result) => {
      if (!result || !result.number) return;
      const blockNum = parseInt(result.number ?? "0x0", 16);
      this.emit({
        type: "newHead",
        blockNumber: blockNum,
        blockHash: result.hash ?? "",
        parentHash: result.parentHash ?? "",
        timestamp: parseInt(result.timestamp ?? "0x0", 16),
      });
    });
  }

  private subscribePendingTransactions(): void {
    this.sendSubscription<string>("newPendingTransactions", (result) => {
      if (typeof result !== "string" || !result.startsWith("0x")) return;
      // Add to throttled queue instead of immediate fetch
      if (this.pendingTxQueue.length < (this.options.maxPendingTxsPerTick ?? 1000)) {
        this.pendingTxQueue.push(result);
      }
    });
  }

  private processTxQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pendingTxQueue.length === 0) return;

    const batch = this.pendingTxQueue.splice(0, this.MAX_BATCH_SIZE);
    for (const hash of batch) {
      try {
        this.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getTransactionByHash",
            params: [hash],
            id: this.requestId++,
          }),
        );
      } catch {
        /* skip */
      }
    }
  }

  private sendSubscription<T>(subscriptionType: string, onResult: (result: T) => void): void {
    if (!this.ws) return;
    const id = this.requestId++;
    let subscriptionId: string | null = null;
    const origOnMessage = this.ws.onmessage;
    this.ws.onmessage = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data as string) as Record<string, unknown>;
        if (data.id === id && data.result) {
          // Subscription confirmed
          subscriptionId = data.result as string;
        } else if (data.method === "eth_subscription" && data.params) {
          const params = data.params as Record<string, unknown>;
          if (params.subscription === subscriptionId) {
            const subResult = params.result;
            if (subResult) {
              onResult(subResult as T);
            }
          }
        }
      } catch {
        /* skip */
      }
      if (typeof origOnMessage === "function") {
        origOnMessage.call(this.ws!, msg);
      }
    };
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_subscribe",
        params: [subscriptionType],
        id,
      }),
    );
  }

  private handleRpcResponse(data: { id: number; result: unknown }): void {
    const r = data.result as Record<string, unknown> | undefined;
    if (r && typeof r === "object" && typeof r.hash === "string" && typeof r.from === "string") {
      this.emit({
        type: "newPendingTx",
        hash: r.hash,
        from: r.from,
        to: typeof r.to === "string" ? r.to : null,
        input: typeof r.input === "string" ? r.input : "0x",
        value: typeof r.value === "string" ? r.value : "0x0",
      });
    }
  }

  private emit(event: WsEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        /* handler error */
      }
    }
  }
}
