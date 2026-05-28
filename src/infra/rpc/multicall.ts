import { type PublicClient, type Address, decodeFunctionResult, encodeFunctionData } from "viem";

const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";

const MULTICALL_ABI = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple[]",
        name: "calls",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        type: "tuple[]",
        name: "returnData",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export interface MulticallRequest {
  target: Address;
  allowFailure?: boolean;
  abi: any;
  functionName: string;
  args?: any[];
}

/**
 * Batch many read-only contract calls into a single RPC request.
 * Crucial for state consistency and reducing RPC overhead.
 */
export async function performMulticall(client: PublicClient, requests: MulticallRequest[]): Promise<any[]> {
  if (requests.length === 0) return [];

  const calls = requests.map((req) => ({
    target: req.target,
    allowFailure: req.allowFailure ?? true,
    callData: encodeFunctionData({
      abi: req.abi,
      functionName: req.functionName,
      args: req.args,
    }),
  }));

  const { result } = await client.simulateContract({
    address: MULTICALL3_ADDRESS,
    abi: MULTICALL_ABI,
    functionName: "aggregate3",
    args: [calls],
  });

  return result.map((res, i) => {
    if (!res.success) return null;
    try {
      return decodeFunctionResult({
        abi: requests[i].abi,
        functionName: requests[i].functionName,
        data: res.returnData,
      });
    } catch (_err: unknown) {
      return null;
    }
  });
}
