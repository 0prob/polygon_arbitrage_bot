import { polygon as polygonViem, type Chain } from "viem/chains";

export const polygon = polygonViem;

export const CHAINS: Record<number, Chain> = {
  137: polygon,
};

export function getChain(chainId: number): Chain {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}
