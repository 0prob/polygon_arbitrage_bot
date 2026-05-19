import { encodeAbiParameters, keccak256, getAddress } from "viem";

export interface OrderParams {
  escrowToken: `0x${string}`;
  escrowAmount: bigint;
  exclusiveFiller: `0x${string}`;
  excludabilityDeadline: number;
  katanaExecutionPayload: `0x${string}`;
  expectedOutputToken: `0x${string}`;
  expectedMinOutput: bigint;
}

export function buildOrderData(params: OrderParams): `0x${string}` {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint32" },
      { type: "bytes" },
      { type: "address" },
      { type: "uint256" },
    ],
    [
      params.exclusiveFiller,
      params.excludabilityDeadline,
      params.katanaExecutionPayload,
      params.expectedOutputToken,
      params.expectedMinOutput,
    ],
  );
}

export function computeOrderId(escrowToken: `0x${string}`, escrowAmount: bigint, sender: `0x${string}`, salt: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
      ],
      [getAddress(escrowToken), escrowAmount, getAddress(sender), salt],
    ),
  );
}
