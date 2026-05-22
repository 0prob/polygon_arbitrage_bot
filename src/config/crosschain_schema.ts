import * as z from "zod";

export const crossChainArbSchema = z.object({
  enabled: z.boolean().default(false),
  katanaRpcUrl: z.string().default("https://rpc.katana.network"),
  polygonRpcUrl: z.string().default("https://polygon-rpc.com"),
  escrowToken: z.string().default("0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"), // WETH on Polygon
  escrowAmount: z.coerce.bigint().default(BigInt(10e18)), // 10 WETH
  minProfitBps: z.number().int().positive().default(20), // 0.2%
  maxSwapHops: z.number().int().positive().max(5).default(3),
  originSettlerAddress: z.string().optional().default(""),
  katanaExecutorAddress: z.string().optional().default(""),
  polygonSolverPrivateKey: z.string().optional().default(""),
  katanaSolverPrivateKey: z.string().optional().default(""),
  katanaExecutorEnabled: z.boolean().default(true),
  crossChainArbEnabled: z.boolean().default(true),
});

export type CrossChainArbConfig = z.infer<typeof crossChainArbSchema>;
