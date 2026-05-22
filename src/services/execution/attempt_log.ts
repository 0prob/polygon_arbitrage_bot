export interface AttemptEntry {
  timestamp: number;
  routeKey: string;
  profit: bigint;
  gasCost: bigint;
  success: boolean;
  error?: string;
}

export type AttemptLogSink = (entry: AttemptEntry) => void;

const sinks: AttemptLogSink[] = [];

const MAX_SINKS = 100;

export function setAttemptLogSink(sink: AttemptLogSink): void {
  if (sinks.length >= MAX_SINKS) {
    sinks.shift();
  }
  sinks.push(sink);
}

export function clearAttemptLogSinks(): void {
  sinks.length = 0;
}

export function logAttempt(entry: AttemptEntry): void {
  for (const sink of sinks) sink(entry);
}
