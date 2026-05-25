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

export type WsEvent = NewHeadEvent | NewPendingTxEvent | NewLogEvent;

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

  constructor(private options: WebSocketSubscriberOptions) {
  }

  onEvent(handler: WsEventHandler): void {
    this.eventHandlers.push(handler);
  }

  removeHandler(handler: WsEventHandler): void {
    this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
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
          const data = JSON.parse(msg.data as string) as Record<string, unknown>;
          if (data.method === "eth_subscription" && data.params) {
            const params = data.params as Record<string, unknown>;
            const result = params.result as Record<string, string> | undefined;
            if (result) {
              this.handleSubscriptionMessage(result);
            }
          }
        } catch { /* skip malformed */ }
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
    } catch { /* ignore */ }
  }

  private subscribeNewHeads(): void {
    this.sendSubscription("newHeads", (result: Record<string, string>) => {
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
    this.sendSubscription("newPendingTransactions", (result: string) => {
      // result is tx hash, we need to fetch details
      void this.fetchAndEmitPendingTx(result);
    });
  }

  private async fetchAndEmitPendingTx(hash: string): Promise<void> {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getTransactionByHash",
          params: [hash],
          id: this.requestId++,
        }));
      }
    } catch { /* ignore */ }
  }

  private sendSubscription(subscriptionType: string, onResult: (result: any) => void): void {
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
            onResult(subResult as Record<string, string>);
          }
        }
      } catch { /* skip */ }
      if (origOnMessage) {
        (origOnMessage as Function)(msg);
      }
    };
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_subscribe",
      params: [subscriptionType],
      id,
    }));
  }

  private handleSubscriptionMessage(result: Record<string, string>): void {
    if (result.number) {
      const blockNum = parseInt(result.number ?? "0x0", 16);
      this.emit({
        type: "newHead",
        blockNumber: blockNum,
        blockHash: result.hash ?? "",
        parentHash: result.parentHash ?? "",
        timestamp: parseInt(result.timestamp ?? "0x0", 16),
      } as NewHeadEvent);
    } else if (result.hash && result.from) {
      this.emit({
        type: "newPendingTx",
        hash: result.hash,
        from: result.from,
        to: result.to ?? null,
        input: result.input ?? "0x",
        value: result.value ?? "0x0",
      } as NewPendingTxEvent);
    }
  }

  private emit(event: WsEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch { /* handler error */ }
    }
  }
}
