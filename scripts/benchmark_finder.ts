import { findCycles } from "../src/pipeline/finder.ts";
import type { RoutingGraph, SwapEdge } from "../src/pipeline/types.ts";
import { MAJOR_TOKENS } from "../src/core/constants.ts";
import type { Address } from "../src/core/types/common.ts";

// Create a mock RoutingGraph with a complex network to stress-test the DFS algorithm.
function createMockGraph(numTokens: number, edgesPerToken: number): RoutingGraph {
  const tokens: Address[] = [];
  for (let i = 0; i < numTokens; i++) {
    tokens.push(`0x${i.toString(16).padStart(40, "0")}` as Address);
  }

  // Ensure some MAJOR_TOKENS are present
  const majorList = Array.from(MAJOR_TOKENS) as Address[];
  for (let i = 0; i < Math.min(tokens.length, majorList.length); i++) {
    tokens[i] = majorList[i];
  }

  const adjacency = new Map<string, SwapEdge[]>();
  const poolMeta = new Map();
  const stateRefs = new Map();

  for (let i = 0; i < tokens.length; i++) {
    const tokenIn = tokens[i];
    const edges: SwapEdge[] = [];
    
    // Add edges to other tokens to form cycles
    for (let j = 1; j <= edgesPerToken; j++) {
      const targetIndex = (i + j) % tokens.length;
      const tokenOut = tokens[targetIndex];
      const poolAddress = `0xpool_${i}_to_${targetIndex}` as Address;
      
      edges.push({
        poolAddress,
        protocol: "uniswap_v3",
        tokenIn,
        tokenOut,
        feeBps: 30n,
        stateRef: {},
        zeroForOne: i < targetIndex,
        tokenInIdx: 0,
        tokenOutIdx: 1,
      });
    }
    
    adjacency.set(tokenIn, edges);
  }

  return {
    adjacency,
    poolMeta,
    stateRefs,
    tokens: new Set(tokens),
  };
}

function runBenchmark() {
  console.log("Generating mock graph...");
  // 100 tokens, 10 edges per token = 1000 edges total
  const graph = createMockGraph(100, 10);
  
  console.log("Warming up...");
  for (let i = 0; i < 5; i++) {
    findCycles(graph, 4, 50000);
  }

  console.log("Running timing trials...");
  const start = performance.now();
  const iterations = 50;
  let totalCycles = 0;
  
  for (let i = 0; i < iterations; i++) {
    const cycles = findCycles(graph, 4, 100000);
    totalCycles += cycles.length;
  }
  
  const end = performance.now();
  const avgTime = (end - start) / iterations;
  console.log(`Average execution time: ${avgTime.toFixed(2)} ms`);
  console.log(`Average cycles found: ${totalCycles / iterations}`);
}

runBenchmark();
