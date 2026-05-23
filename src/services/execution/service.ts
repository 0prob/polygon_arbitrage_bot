import type { Logger } from "../../infra/observability/logger.ts";
import type { GasOracle } from "./gas.ts";
import type { NonceManager } from "./nonce.ts";

export interface CandidateExecution {
  routeKey: string;
  calldata: string;
  targetAddress: string;
  value: bigint;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: bigint;
}

export type SubmitTxFn = (tx: { to: string; data: string; value: bigint; nonce: number; maxFee: bigint }) => Promise<string>;

export class ExecutionService {
  private quarantine = new Set<string>();
  private readonly MAX_QUARANTINE = 10_000;
  private _quarantineQueue: string[] = [];

  constructor(
    private logger: Logger,
    private gasOracle: GasOracle,
    private nonceManager: NonceManager,
    private submitters: SubmitTxFn[],
  ) {}

  async start(): Promise<void> {
    await this.gasOracle.start();
    await this.nonceManager.initialize();
    this.logger.info({}, "ExecutionService started");
  }

  stop(): void {
    this.gasOracle.stop();
    this.logger.info({}, "ExecutionService stopped");
  }

  async execute(candidate: CandidateExecution): Promise<ExecutionResult> {
    if (this.quarantine.has(candidate.routeKey)) {
      return { success: false, error: "route quarantined" };
    }

    try {
      const fee = this.gasOracle.getSnapshot();
      if (!fee) {
        this._addQuarantine(candidate.routeKey);
        return { success: false, error: "no gas data" };
      }

      const nonce = this.nonceManager.getNextNonce();
      
      const txHash = await Promise.any(
        this.submitters.map(submit => submit({
            to: candidate.targetAddress,
            data: candidate.calldata,
            value: candidate.value,
            nonce,
            maxFee: fee.maxFee,
        }))
      );

      this.nonceManager.confirmNonce(nonce).catch(() => {});
      this.logger.info({ txHash, routeKey: candidate.routeKey }, "Transaction submitted");
      return { success: true, txHash };
    } catch (err: any) {
      this._addQuarantine(candidate.routeKey);
      if (err instanceof AggregateError) {
        return { success: false, error: err.errors[0]?.message || String(err) };
      }
      return { success: false, error: err?.message || String(err) };
    }
  }

  private _addQuarantine(routeKey: string): void {
    if (this.quarantine.size >= this.MAX_QUARANTINE) {
      const oldest = this._quarantineQueue.shift();
      if (oldest) this.quarantine.delete(oldest);
    }
    this.quarantine.add(routeKey);
    this._quarantineQueue.push(routeKey);
  }

  isQuarantined(routeKey: string): boolean {
    return this.quarantine.has(routeKey);
  }
}
