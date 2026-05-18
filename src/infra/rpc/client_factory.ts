import { createPublicClient, createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export interface ClientFactoryOptions {
  batchSize?: number;
  batchWaitMs?: number;
  timeoutMs?: number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WAIT_MS = 16;
const DEFAULT_TIMEOUT_MS = 8_000;

function publicClientConfig(rpcUrl: string, opts?: ClientFactoryOptions) {
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchWaitMs = opts?.batchWaitMs ?? DEFAULT_BATCH_WAIT_MS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    chain: polygon,
    transport: http(rpcUrl, {
      batch: { batchSize },
      timeout: timeoutMs,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
    batch: {
      multicall: { wait: batchWaitMs, batchSize },
    },
  } as const;
}

export function createReadClients(urls: string[], opts?: ClientFactoryOptions) {
  return urls.map((url) =>
    createPublicClient({
      ...publicClientConfig(url, opts),
    }),
  );
}

export function createExecutionClient(rpcUrl: string, privateKey?: string) {
  const pk = privateKey ? (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) : undefined;
  const account = pk ? privateKeyToAccount(pk as `0x${string}`) : undefined;
  return createWalletClient({
    ...(account ? { account } : {}),
    chain: polygon,
    transport: http(rpcUrl, {
      timeout: DEFAULT_TIMEOUT_MS,
      retryCount: 0,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
  });
}

export function createGasEstimationClient(rpcUrl: string, opts?: ClientFactoryOptions) {
  return createPublicClient({
    chain: polygon,
    transport: http(rpcUrl, {
      batch: true,
      timeout: opts?.timeoutMs ?? 5_000,
      fetchOptions: { headers: { Connection: "keep-alive" } },
    }),
    batch: {
      multicall: { wait: opts?.batchWaitMs ?? DEFAULT_BATCH_WAIT_MS },
    },
  });
}
