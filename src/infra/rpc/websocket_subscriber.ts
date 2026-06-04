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
  private requestId = 0;

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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private connect(): void {
    if (!this.running) return;
    try {
      this.ws = new WebSocket(this.options.url);

      this.ws.onopen = () => {
        this.emit({ type: "newHead", blockNumber: 0, blockHash: "", parentHash: "", timestamp: Date.now() } as NewHeadEvent);
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

          // eth_subscription messages are handled by sendSubscription wrappers above in the chain.
          // Only handle RPC responses (eth_getTransactionByHash replies) here.
          if (typeof data.id === "number" && data.result !== undefined) {
            this.handleRpcResponse(data as { id: number; result: unknown });
          }
        } catch (err) {
          /* skip malformed or unexpected formats */
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
    const delay = this.options.reconnectDelayMs ?? 5_000;
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
      void this.fetchAndEmitPendingTx(result);
    });
  }

  private async fetchAndEmitPendingTx(hash: string): Promise<void> {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getTransactionByHash",
            params: [hash],
            id: this.requestId++,
          }),
        );
      }
    } catch {
      /* ignore */
    }
  }

  private sendSubscription<T>(subscriptionType: string, onResult: (result: T) => void): void {
    if (!this.ws) return;
    const id = this.requestId++;
    const origOnMessage = this.ws.onmessage;
    this.ws.onmessage = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(msg.data as string) as Record<string, unknown>;
        if (data.id === id && data.result) {
          // Subscription confirmed
        } else if (data.method === "eth_subscription" && data.params) {
          const params = data.params as Record<string, unknown>;
          const subResult = params.result;
          if (subResult) {
            onResult(subResult as T);
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
