#!/usr/bin/env bun
/**
 * Transaction Simulator - Anvil (Foundry) + Alchemy MCP wrapper for the AI Agent
 *
 * Lets the AI test arbitrary transactions (or full ArbExecutor routes) against
 * live mainnet Polygon state forks — either local Anvil or remote via Alchemy simulate APIs.
 *
 * Primary modes:
 *   1. Local Anvil fork (recommended for deep tracing + state overrides + impersonation)
 *   2. Direct Alchemy MCP simulateExecution / simulateAssetChanges / traceCall (no local resources)
 *
 * Usage examples:
 *   # Start a persistent fork (run in separate shell or background)
 *   bun .grok/skills/arb-tx-tools/scripts/simulator.ts start-fork --port 8546
 *
 *   # Simulate a raw tx against local anvil (or --rpc any fork)
 *   bun .grok/skills/arb-tx-tools/scripts/simulator.ts simulate --to 0x... --data 0x... --from 0xExecutorOwner
 *
 *   # Simulate using the project's ArbExecutor on a fresh fork (very powerful)
 *   bun .grok/skills/arb-tx-tools/scripts/simulator.ts simulate-arb --calls '[{"target":"0x..","data":"0x.."}]' --flash USDC --amount 1000000
 *
 *   # For cloud (Alchemy MCP) - the AI should prefer this path when instructed in SKILL.md:
 *   #   Use search_tool("simulateExecution") then use_tool("alchemy__simulateExecution", {...})
 */

import { createPublicClient, http, type Hex, type Address, parseAbi, encodeFunctionData, decodeErrorResult } from "viem";
import { polygon } from "viem/chains";
import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Consolidated reuse: AnvilManager from shared MCP modules for fork lifecycle (start, detect listening, stop, info)
import { AnvilManager } from "../../../../scripts/arb-tx-tools/anvil-manager.ts";

// Pull in ABIs + executor knowledge so we can build realistic arb simulations
import { EXECUTOR_ABI, EXECUTOR_AAVE_ABI } from "../../../../src/services/execution/calldata/abis.ts";
import { USDC, USDC_NATIVE, WMATIC, WETH } from "../../../../src/config/addresses.ts"; // may not exist exactly - fallback below

const DEFAULT_ANVIL_PORT = 8545;
const ANVIL_RPC = (port: number) => `http://127.0.0.1:${port}`;

const KNOWN_TOKENS: Record<string, Address> = {
  USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
};

function parseArgs(argv: string[]) {
  const args: any = { port: DEFAULT_ANVIL_PORT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        args[k] = v;
        i++;
      } else args[k] = true;
    } else if (!args._cmd) args._cmd = a;
  }
  return args;
}

function getRpcFromEnv(): string {
  return process.env.POLYGON_RPC_URL || process.env.POLYGON_RPC_URLS?.split(",")[0] || process.env.ETH_RPC_URL || "https://polygon-rpc.com";
}

async function startFork(args: any) {
  const port = Number(args.port || DEFAULT_ANVIL_PORT);
  const rpcUrl = args.rpc || getRpcFromEnv();
  const forkBlockNumber = args.block ? Number(args.block) : undefined;

  console.log("=== Starting Anvil Fork (using shared AnvilManager) ===");
  console.log(`Forking: ${rpcUrl}`);

  // Consolidated: delegate to shared AnvilManager (from scripts/arb-tx-tools/anvil-manager.ts)
  // This reuses spawn, "Listening on" detection, info tracking, and stop logic.
  const manager = new AnvilManager();
  try {
    const info = await manager.startFork({ port, forkBlockNumber, rpcUrl });
    console.log(`Listening: ${info.rpcUrl}`);
    console.log(`Fork block: ${info.forkBlock || "latest"}`);
    console.log(`PID: ${info.pid}`);
    console.log("\nFork managed via shared AnvilManager (reused from MCP modules).");
    console.log("Stop with: pkill anvil   (or kill the listed PID).");
    if (!args.background) {
      console.log("\n(Holding; Ctrl-C to terminate.)");
      await new Promise(() => {});
    }
  } catch (e: any) {
    console.error("Failed to start fork via manager:", e.message);
    // Fallback print the manual command
    const block = forkBlockNumber ? `--fork-block-number ${forkBlockNumber}` : "";
    console.log("Manual command:");
    console.log(`  anvil --fork-url "${rpcUrl}" --port ${port} ${block} --chain-id 31337 ...`);
  }
}

async function simulateCall(args: any) {
  const to = args.to as Address;
  const data = (args.data || "0x") as Hex;
  const from = (args.from || "0x0000000000000000000000000000000000000001") as Address;
  const value = args.value ? BigInt(args.value) : 0n;
  const usePublic = !!args["public-rpc"];
  const rpc = args.rpc || (usePublic ? getRpcFromEnv() : ANVIL_RPC(args.port || DEFAULT_ANVIL_PORT));
  const useAnvil = !usePublic;

  console.log("=== Transaction Simulation ===");
  console.log({ to, data: data.slice(0, 66) + (data.length > 66 ? "..." : ""), from, value: value.toString(), rpc });

  const client = createPublicClient({ chain: polygon, transport: http(rpc) });

  try {
    const result = await client.call({
      account: from,
      to,
      data,
      value,
    });
    console.log("\n✅ SUCCESS");
    console.log("Return data:", result.data || "0x");
    if (result.gasUsed) console.log("Gas estimate (approx):", result.gasUsed?.toString());
  } catch (err: any) {
    console.log("\n❌ REVERT / FAILURE");
    const revertData: Hex = err?.data || err?.cause?.data || "0x";
    console.log("Raw revert data:", revertData);

    // Attempt decode using same logic as abicoder (inline minimal)
    try {
      const decoded = decodeErrorResult({ abi: [...EXECUTOR_ABI, ...EXECUTOR_AAVE_ABI] as any, data: revertData });
      console.log("Decoded custom error:", decoded.errorName, decoded.args);
    } catch {
      if (revertData.startsWith("0x08c379a0")) {
        console.log("Likely Error(string) revert (use abicoder.ts for full decode)");
      }
    }

    // If this was against a real RPC (not anvil), suggest anvil for better traces
    if (!useAnvil || rpc.includes("alchemy") || rpc.includes("polygon-rpc")) {
      console.log("\nTip: For full stack traces + state diff, start a local anvil fork first and target --rpc http://127.0.0.1:8545");
    }
  }
}

async function simulateArb(args: any) {
  // High-level helper: simulate a flash-loan arb route on a fresh fork
  const flashToken = (args.flash || "USDC") as string;
  const flashAmount = args.amount || "1000000000"; // 1000 USDC default (6 decimals)
  const callsJson = args.calls as string; // JSON array of {target, data, value?}
  const rpc = args.rpc || getRpcFromEnv();
  const port = Number(args.port || 18545); // use uncommon port for temp fork

  if (!callsJson) {
    console.error('Missing --calls \'[{ "target": "0x..", "data": "0x.." }]\' ');
    process.exit(1);
  }

  let calls: any[];
  try {
    calls = JSON.parse(callsJson);
  } catch (e) {
    console.error("Invalid JSON for --calls");
    throw e;
  }

  console.log("=== Arb Route Simulation on Fresh Anvil Fork ===");
  console.log(`Flash: ${flashToken} ${flashAmount}`);
  console.log(`#Calls: ${calls.length}`);

  // 1. Start a temporary anvil fork (we use a throwaway port and kill after)
  const forkRpc = ANVIL_RPC(port);
  console.log(`Starting temp anvil on ${forkRpc} (forking ${rpc})...`);

  const anvil = spawn("anvil", ["--fork-url", rpc, "--port", String(port), "--chain-id", "31337", "--silent"]);

  // Give anvil 1.5s to come up
  await new Promise((r) => setTimeout(r, 1500));

  const client = createPublicClient({ chain: polygon, transport: http(forkRpc) });

  try {
    // Encode the execute call (using Balancer or Aave path - we pick Balancer-style for simplicity)
    // In real use the agent would have already built the exact calldata via the bot's builder.
    const executorAddr = "0x0000000000000000000000000000000000000000"; // TODO: real deployed or use --executor
    // For now we demonstrate the pattern: the script shows how to do full end-to-end fork testing.

    console.log("\n(Full route simulation scaffolding ready)");
    console.log("To execute a real arb simulation on the fork you would:");
    console.log("  1. Impersonate an account with gas funds on the fork (anvil_impersonateAccount)");
    console.log("  2. Fund it");
    console.log("  3. Call the ArbExecutor with proper FlashParams + route calls");
    console.log("  4. Decode any revert with abicoder.ts");
    console.log("\nExample next step after this script matures:");
    console.log(
      `  cast call --rpc-url ${forkRpc} <executor> "executeArb(address,uint256,(address,uint256,uint256,bytes32,(address,uint256,bytes)[]))" ...`,
    );

    // Quick smoke: just do an eth_call to a known contract to prove fork is live
    const code = await client.getBytecode({ address: KNOWN_TOKENS.USDC });
    console.log(`\nFork health check: USDC bytecode size on fork = ${code?.length || 0} bytes (should be >0)`);
  } finally {
    anvil.kill("SIGTERM");
  }
}

async function useAlchemyMcpGuidance() {
  console.log(`=== Alchemy MCP Simulation Path (Recommended for AI when no local anvil) ===

The connected Alchemy MCP server provides production-grade simulation tools:

  - simulateExecution / simulateExecutionBundle
  - simulateAssetChanges / simulateAssetChangesBundle
  - traceCall, debugTraceCall, debugTraceTransaction
  - ethCall (with state overrides in some cases)

How the AI agent should use them (exact flow):

1. Call search_tool first to get the precise input schema:
     search_tool({ query: "alchemy simulateExecution" })

2. Then invoke via use_tool:
     use_tool({
       tool_name: "alchemy__simulateExecution",   // or whatever the qualified name returns
       tool_input: {
         network: "polygon-mainnet",
         // from, to, data, value, block, etc.
         // See returned schema
       }
     })

This gives you asset changes, gas, reverts, traces WITHOUT spinning up anvil.
Perfect for quick "would this arb revert?" checks against live state.

For deepest debugging (storage writes, full EVM traces), combine with local anvil + this script.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._cmd || "help";

  if (cmd === "start-fork" || cmd === "fork") {
    await startFork(args);
  } else if (cmd === "simulate" || cmd === "call") {
    await simulateCall(args);
  } else if (cmd === "simulate-arb" || cmd === "arb") {
    await simulateArb(args);
  } else if (cmd === "alchemy" || cmd === "mcp" || cmd === "guide") {
    await useAlchemyMcpGuidance();
  } else {
    console.log(`Transaction Simulator for Arb Bot (Anvil + Alchemy MCP)

Commands:
  start-fork [--port 8546] [--rpc URL] [--block N] [--background]
             Start (or print command for) a local anvil mainnet fork.

  simulate --to 0x.. --data 0x... [--from 0x..] [--value 0] [--rpc http://127.0.0.1:8545]
             Execute eth_call against fork (or public RPC) and decode reverts.

  simulate-arb --calls '[{"target":"..","data":".."}]' --flash USDC --amount 1000000000
             End-to-end arb route test on a temporary fresh fork (scaffolding).

  alchemy | mcp | guide
             Detailed instructions for using the live Alchemy MCP simulation tools
             (search_tool + use_tool). Best for the AI agent - zero local setup.

Examples:
  # Terminal 1
  bun .grok/skills/arb-tx-tools/scripts/simulator.ts start-fork --port 8546

  # Terminal 2 / agent
  bun .grok/skills/arb-tx-tools/scripts/simulator.ts simulate --to 0x... --data 0x...

  # Or let the AI use Alchemy MCP directly (see "guide" subcommand)

Also pairs perfectly with:
  bun .grok/skills/arb-tx-tools/scripts/abicoder.ts decode-revert --data 0x...
`);
  }
}

main().catch(console.error);
