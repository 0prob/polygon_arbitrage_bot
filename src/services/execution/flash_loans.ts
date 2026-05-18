import { FlashLoanSource } from "../../core/types/execution.ts";

export interface FlashLoanQuote {
  source: FlashLoanSource;
  amount: bigint;
  fee: bigint;
  token: string;
}

export type LiquidityChecker = (token: string, amount: bigint, source: FlashLoanSource) => Promise<boolean>;

export interface RpcClientForLiquidity {
  call: (params: { to: string; data: string }) => Promise<string>;
}

const BALANCE_OF_SELECTOR = "0x70a08231";
const GET_RESERVE_DATA_SELECTOR = "0x35ea6a75";

function encodeAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, "0");
}

function hexToBigInt(hex: string): bigint {
  const cleaned = hex.startsWith("0x") ? hex : `0x${hex}`;
  return BigInt(cleaned || "0x0");
}

export function createLiquidityChecker(
  rpc: RpcClientForLiquidity,
  balancerVaultAddress: string,
  aavePoolAddress: string,
): LiquidityChecker {
  return async (token: string, amount: bigint, source: FlashLoanSource): Promise<boolean> => {
    if (source === FlashLoanSource.BALANCER) {
      const data = `${BALANCE_OF_SELECTOR}${encodeAddress(balancerVaultAddress)}`;
      const result = await rpc.call({ to: token, data });
      const balance = hexToBigInt(result);
      return balance >= amount;
    }

    if (source === FlashLoanSource.AAVE_V3) {
      const data = `${GET_RESERVE_DATA_SELECTOR}${encodeAddress(token)}`;
      const result = await rpc.call({ to: aavePoolAddress, data });
      const hex = result.startsWith("0x") ? result.slice(2) : result;
      const availableLiquidity = BigInt("0x" + (hex.length >= 128 ? hex.slice(64, 128) : "0"));
      return availableLiquidity >= amount;
    }

    return false;
  };
}

export async function selectFlashLoanSource(
  token: string,
  amount: bigint,
  checkLiquidity: LiquidityChecker,
): Promise<FlashLoanSource> {
  const balancerAvailable = await checkLiquidity(token, amount, FlashLoanSource.BALANCER);
  if (balancerAvailable) return FlashLoanSource.BALANCER;

  return FlashLoanSource.AAVE_V3;
}

export function computeFlashLoanFee(amount: bigint, source: FlashLoanSource): bigint {
  if (source === FlashLoanSource.BALANCER) return 0n;
  if (source === FlashLoanSource.AAVE_V3) return (amount * 5n) / 10_000n;
  return 0n;
}
