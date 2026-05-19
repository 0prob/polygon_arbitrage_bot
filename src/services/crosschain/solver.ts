import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, type Chain } from "viem/chains";
import type { CrossChainRoute } from "./types.ts";
import { buildOrderData, computeOrderId } from "./order.ts";
import { encodeKatanaArbTx, type ExecuteArbInput } from "../execution/crosschain_calldata.ts";

const APPROVE_ABI = [
  { name: "approve", type: "function", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
] as const;

const EXEC_ARB_ORDER_ABI = [
  { name: "executeArbOrder", type: "function", inputs: [
    { type: "address" }, { type: "uint256" }, { type: "bytes" },
  ], outputs: [{ type: "bytes32" }], stateMutability: "nonpayable" },
] as const;

const katanaChain: Chain = {
  id: 747474,
  name: "Katana",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.KATANA_RPC_URL ?? "https://rpc.katana.network"] } },
} as const;

export interface SolverBotConfig {
  polygonSolverKey: `0x${string}`;
  katanaSolverKey: `0x${string}`;
  crossChainIntentOrigin: `0x${string}`;
  katanaExecutor: `0x${string}`;
  escrowToken: `0x${string}`;
  escrowAmount: bigint;
  polygonRpcUrl: string;
  katanaRpcUrl: string;
}

export class SolverBot {
  private config: SolverBotConfig;
  private polygonClient: ReturnType<typeof createPublicClient>;
  private katanaClient: ReturnType<typeof createPublicClient>;
  private polygonWallet: ReturnType<typeof createWalletClient>;
  private katanaWallet: ReturnType<typeof createWalletClient>;
  private polyAccount: ReturnType<typeof privateKeyToAccount>;
  private kataAccount: ReturnType<typeof privateKeyToAccount>;

  constructor(config: SolverBotConfig) {
    this.config = config;
    this.polyAccount = privateKeyToAccount(config.polygonSolverKey);
    this.kataAccount = privateKeyToAccount(config.katanaSolverKey);

    this.polygonClient = createPublicClient({ chain: polygon, transport: http(config.polygonRpcUrl) });
    this.katanaClient = createPublicClient({ chain: katanaChain, transport: http(config.katanaRpcUrl) });
    this.polygonWallet = createWalletClient({ account: this.polyAccount, chain: polygon, transport: http(config.polygonRpcUrl) });
    this.katanaWallet = createWalletClient({ account: this.kataAccount, chain: katanaChain, transport: http(config.katanaRpcUrl) });
  }

  async executeCrossChainArb(route: CrossChainRoute): Promise<boolean> {
    try {
      // Step 1: Create order on Polygon
      const orderData = buildOrderData({
        escrowToken: route.escrowToken,
        escrowAmount: route.escrowAmount,
        exclusiveFiller: this.kataAccount.address,
        excludabilityDeadline: Math.floor(Date.now() / 1000) + 3600,
        katanaExecutionPayload: "0x",
        expectedOutputToken: route.profitToken,
        expectedMinOutput: route.minProfitOut,
      });

      const orderId = computeOrderId(route.escrowToken, route.escrowAmount, this.polyAccount.address, BigInt(Math.floor(Date.now() / 1000)));

      // Approve escrow token
      const approveHash = await this.polygonWallet.writeContract({
        account: this.polyAccount,
        chain: polygon,
        address: getAddress(route.escrowToken),
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [getAddress(this.config.crossChainIntentOrigin), this.config.escrowAmount],
      });
      await this.polygonClient.waitForTransactionReceipt({ hash: approveHash });

      // Call executeArbOrder
      const execHash = await this.polygonWallet.writeContract({
        account: this.polyAccount,
        chain: polygon,
        address: getAddress(this.config.crossChainIntentOrigin),
        abi: EXEC_ARB_ORDER_ABI,
        functionName: "executeArbOrder",
        args: [getAddress(route.escrowToken), this.config.escrowAmount, orderData],
      });
      await this.polygonClient.waitForTransactionReceipt({ hash: execHash });

      // Step 2: Execute arb on Katana
      const arbInput: ExecuteArbInput = {
        executorAddress: getAddress(this.config.katanaExecutor),
        flashPool: route.flashPool,
        flashProtocol: route.flashProtocol,
        flashAmount: route.flashAmount,
        swapPath: route.swapPath,
        profitToken: route.profitToken,
        minProfitOut: route.minProfitOut,
        orderId,
      };
      const katanaTx = encodeKatanaArbTx(arbInput);
      const kataHash = await this.katanaWallet.sendTransaction({
        account: this.kataAccount,
        chain: katanaChain,
        ...katanaTx,
      });
      await this.katanaClient.waitForTransactionReceipt({ hash: kataHash });

      // Step 3: Wait for AggLayer proof + claim (simplified — in production, monitor for proof then call claimOrder)
      console.log(`Cross-chain arb completed: orderId=${orderId}, kataHash=${kataHash}`);
      return true;
    } catch (err) {
      console.error("Cross-chain arb failed:", err);
      return false;
    }
  }
}
