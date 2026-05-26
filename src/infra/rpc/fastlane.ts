import { type WalletClient } from "viem";

export interface FastLaneConfig {
  enabled: boolean;
  rpcUrl: string;
  conditional: {
    blockNumberWindow: number;
    timestampWindowS: number;
  };
}

export const DEFAULT_FASTLANE_CONFIG: FastLaneConfig = {
  enabled: false,
  rpcUrl: "https://polygon-rpc.fastlane.xyz",
  conditional: {
    blockNumberWindow: 50,
    timestampWindowS: 60,
  },
};

export interface ConditionalTransactionOptions {
  knownAccounts?: Record<string, { nonce: number; balance: string; state?: string }>;
  blockNumberMin?: number;
  blockNumberMax?: number;
  timestampMin?: number;
  timestampMax?: number;
}

export interface FastLaneBundle {
  jsonrpc: "2.0";
  id: number;
  method: "pfl_sendRawTransactionConditional";
  params: [string, ConditionalTransactionOptions];
}

export function createFastLaneBundle(signedTx: string, options: ConditionalTransactionOptions, id: number = 1): FastLaneBundle {
  return {
    jsonrpc: "2.0",
    id,
    method: "pfl_sendRawTransactionConditional",
    params: [signedTx, options],
  };
}

export class FastLaneSubmitter {
  private bundleId = 0;

  constructor(
    private config: FastLaneConfig,
    private walletClient: WalletClient,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async submitTransaction(tx: {
    to: string;
    data: string;
    value: bigint;
    nonce: number;
    maxFee: bigint;
    priorityFee: bigint;
  }): Promise<string> {
    if (!this.config.enabled) {
      throw new Error("FastLane is not enabled");
    }

    const signedTx = await this.walletClient.signTransaction({
      account: this.walletClient.account!,
      chain: this.walletClient.chain,
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.value,
      nonce: tx.nonce,
      maxFeePerGas: tx.maxFee,
      maxPriorityFeePerGas: tx.priorityFee,
      gas: this.estimateGasLimit(tx.data),
    });

    this.bundleId++;
    const bundle = createFastLaneBundle(
      signedTx,
      {
        blockNumberMax: this.config.conditional.blockNumberWindow,
        timestampMax: this.config.conditional.timestampWindowS,
      },
      this.bundleId,
    );

    const response = await fetch(this.config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`FastLane RPC error: ${response.status}`);
    }

    const json = (await response.json()) as { result?: string; error?: { message: string } };
    if (json.error) {
      throw new Error(`FastLane submission failed: ${json.error.message}`);
    }

    return json.result ?? signedTx;
  }

  private estimateGasLimit(_data: string): bigint {
    return 500_000n;
  }
}
