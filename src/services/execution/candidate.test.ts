import { describe, it, expect } from "vitest";
import { buildExecutionCandidate } from "./candidate.ts";

describe("CandidateBuilder", () => {
  it("should transform a profitable result into a candidate execution", () => {
    const profitable: any = {
      cycle: { 
        startToken: "0x1111111111111111111111111111111111111111", 
        edges: [
          {
            poolAddress: "0x2222222222222222222222222222222222222222",
            tokenIn: "0x1111111111111111111111111111111111111111",
            tokenOut: "0x3333333333333333333333333333333333333333",
            protocol: "UNISWAP_V2",
            feeBps: 30
          }
        ] 
      },
      result: { 
        amountIn: 100n, 
        amountOut: 110n, 
        hopAmounts: [100n, 110n], 
        tokenPath: ["0x1111111111111111111111111111111111111111", "0x3333333333333333333333333333333333333333"], 
        poolPath: ["0x2222222222222222222222222222222222222222"] 
      },
      assessment: { netProfitAfterGas: 5n }
    };
    const config: any = { 
      executorAddress: "0x4444444444444444444444444444444444444444", 
      fromAddress: "0x5555555555555555555555555555555555555555" 
    };
    
    const candidate = buildExecutionCandidate(profitable, config, { slippageBps: 50 });
    expect(candidate.targetAddress).toBeDefined();
    expect(candidate.calldata).toBeDefined();
    expect(candidate.routeKey).toBeDefined();
    expect(candidate.value).toBe(0n);
  });
});
