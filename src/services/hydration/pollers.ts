import type { Address } from "../../core/types/common.ts";

export type RpcCaller = (address: Address, abi: string[], fn: string, args: unknown[]) => Promise<unknown>;

export async function pollV2Pool(
  poolAddress: Address,
  callContract: RpcCaller,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await callContract(poolAddress, [], "getReserves", []) as { _reserve0: bigint; _reserve1: bigint };
    return {
      reserve0: result._reserve0,
      reserve1: result._reserve1,
    };
  } catch {
    return null;
  }
}

export async function pollV3Pool(
  poolAddress: Address,
  callContract: RpcCaller,
): Promise<Record<string, unknown> | null> {
  try {
    const slot0 = await callContract(poolAddress, [], "slot0", []) as { sqrtPriceX96: bigint; tick: number };
    const liquidity = await callContract(poolAddress, [], "liquidity", []) as bigint;
    const fee = await callContract(poolAddress, [], "fee", []) as bigint;
    return {
      sqrtPriceX96: slot0.sqrtPriceX96,
      tick: slot0.tick,
      liquidity,
      fee,
    };
  } catch {
    return null;
  }
}

export async function pollCurvePool(
  poolAddress: Address,
  nCoins: number,
  callContract: RpcCaller,
): Promise<Record<string, unknown> | null> {
  try {
    const balances: bigint[] = [];
    for (let i = 0; i < nCoins; i++) {
      const bal = await callContract(poolAddress, [], "balances", [i]) as bigint;
      balances.push(bal);
    }
    const A = await callContract(poolAddress, [], "A", []) as bigint;
    const fee = await callContract(poolAddress, [], "fee", []) as bigint;
    return { balances, A, fee, nCoins };
  } catch {
    return null;
  }
}

export async function pollBalancerPool(
  poolAddress: Address,
  vaultAddress: Address,
  callContract: RpcCaller,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await callContract(vaultAddress, [], "getPoolTokens", [poolAddress]) as {
      tokens: string[];
      balances: bigint[];
      lastChangeBlock: bigint;
    };
    await callContract(poolAddress, [], "getPoolId", []);
    const poolType = await callContract(poolAddress, [], "getAmplificationParameter", []).then(
      () => "stable",
      () => "weighted",
    );
    return { balances: result.balances, poolType, fee: 0n };
  } catch {
    return null;
  }
}
