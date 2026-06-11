import { createPublicClient, http, parseAbi } from "viem";
import { polygon } from "viem/chains";

const ARCHIVE_TEST_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const; // USDC on Polygon
const ARCHIVE_TEST_BLOCK = 80_000_000n;
const DECIMALS_TEST_ABI = parseAbi(["function decimals() view returns (uint8)"]);

/**
 * Test RPC URLs for support of historical archival eth_call (used by HyperIndex
 * effects for token metadata etc at PairCreated block heights). Removes any that
 * fail the call (non-archival, down, or incompatible free RPCs).
 */
export async function filterArchivalRpcUrls(urls: readonly string[]): Promise<string[]> {
  if (!urls || urls.length === 0) return [];
  const probeTimeoutMs = 7000;

  const checks = urls.map(async (url) => {
    try {
      const transport = http(url, {
        timeout: probeTimeoutMs,
        retryCount: 0,
      });
      const client = createPublicClient({ chain: polygon, transport });
      const result = await client.readContract({
        address: ARCHIVE_TEST_TOKEN,
        abi: DECIMALS_TEST_ABI,
        functionName: "decimals",
        blockNumber: ARCHIVE_TEST_BLOCK,
      });
      return Number(result) === 6 ? url : null;
    } catch (err) {
      console.warn("[archival] RPC archival probe failed:", err);
      return null;
    }
  });

  const settled = await Promise.allSettled(checks);
  return settled.map((s) => (s.status === "fulfilled" ? s.value : null)).filter((u): u is string => !!u);
}
