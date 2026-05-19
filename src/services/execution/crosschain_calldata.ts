import { encodeFunctionData, getAddress, encodeAbiParameters, keccak256 } from "viem";

// ─── Types ─────────────────────────────────────────────────────

export type SwapStep = {
  pool: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  protocol: 2 | 3; // 2=V2, 3=V3
};

export type ExecuteArbInput = {
  executorAddress: `0x${string}`;
  flashPool: `0x${string}`;
  flashProtocol: 2 | 3;
  flashAmount: bigint;
  swapPath: SwapStep[];
  profitToken: `0x${string}`;
  minProfitOut: bigint;
  orderId: `0x${string}`;
};

// ─── ABIs ───────────────────────────────────────────────────────

const KATANA_EXECUTOR_ABI = [
  {
    name: "executeArb",
    type: "function",
    inputs: [
      { name: "flashPool", type: "address" },
      { name: "flashProtocol", type: "uint8" },
      { name: "flashAmount", type: "uint256" },
      {
        name: "swapPath",
        type: "tuple[]",
        components: [
          { name: "pool", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "protocol", type: "uint8" },
        ],
      },
      { name: "profitToken", type: "address" },
      { name: "minProfitOut", type: "uint256" },
      { name: "orderId", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ─── Encoders ───────────────────────────────────────────────────

export function encodeKatanaArbTx(input: ExecuteArbInput) {
  const data = encodeFunctionData({
    abi: KATANA_EXECUTOR_ABI,
    functionName: "executeArb",
    args: [
      getAddress(input.flashPool),
      input.flashProtocol,
      input.flashAmount,
      input.swapPath.map((s) => ({
        pool: getAddress(s.pool),
        tokenIn: getAddress(s.tokenIn),
        tokenOut: getAddress(s.tokenOut),
        protocol: s.protocol,
      })),
      getAddress(input.profitToken),
      input.minProfitOut,
      input.orderId,
    ],
  });
  return { to: getAddress(input.executorAddress), data, value: 0n };
}

export function computeOrderId(escrowToken: string, escrowAmount: bigint, solver: string): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
      ],
      [getAddress(escrowToken), escrowAmount, getAddress(solver), BigInt(Math.floor(Date.now() / 1000))],
    ),
  );
}
