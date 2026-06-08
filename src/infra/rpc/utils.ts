// Utility functions for RPC handling
export function toHexTag(value: bigint | number | string): string {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (typeof value === "number") return `0x${value.toString(16)}`;
  return value;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function handleRpcError(err: unknown, context: string): never {
  if (err instanceof Error) {
    throw new RpcError(`${context}: ${err.message}`, err);
  }
  throw new RpcError(`${context}: unknown error`);
}
