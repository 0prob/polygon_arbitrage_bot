export interface Lifecycle {
  prepare(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
