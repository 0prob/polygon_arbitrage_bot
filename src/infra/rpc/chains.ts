import { polygon as polygonViem, type Chain } from "viem/chains";

export const polygon = polygonViem;

export const katana = {
  id: 747474,
  name: "Katana",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.KATANA_RPC_URL ?? "https://rpc.katana.network"] },
    public: { http: [process.env.KATANA_RPC_URL ?? "https://rpc.katana.network"] },
  },
  blockExplorers: {
    default: { name: "KatanaScan", url: "https://explorer.katana.network" },
  },
} as const satisfies Chain;

export const CHAINS: Record<number, Chain> = {
  137: polygon,
  747474: katana,
};

export function getChain(chainId: number): Chain {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain ID: ${chainId}`);
  return chain;
}
