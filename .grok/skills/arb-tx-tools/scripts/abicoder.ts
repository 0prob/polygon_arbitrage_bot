#!/usr/bin/env bun
/**
 * ABICoder Tool - Specialized decoder for the Arbitrage Bot
 *
 * Decodes transaction inputs, event logs, and revert reasons using project ABIs + viem.
 * Essential for diagnosing exactly why a trade/arb reverted on-chain or in simulation.
 *
 * Usage:
 *   bun .grok/skills/arb-tx-tools/scripts/abicoder.ts decode-input --data 0x...
 *   bun .grok/skills/arb-tx-tools/scripts/abicoder.ts decode-revert --data 0x08c379a0... --reason "optional"
 *   bun .grok/skills/arb-tx-tools/scripts/abicoder.ts decode-tx --hash 0xabc... [--rpc https://...]
 *   bun .grok/skills/arb-tx-tools/scripts/abicoder.ts decode-receipt --hash 0xabc... [--rpc ...]
 *   bun .grok/skills/arb-tx-tools/scripts/abicoder.ts 4byte 0x12345678
 */

import {
  createPublicClient,
  http,
  decodeFunctionData,
  decodeErrorResult,
  decodeEventLog,
  type Hex,
  type Log,
  type Transaction,
} from "viem";
import { polygon } from "viem/chains";
import * as fs from "fs";
import * as path from "path";

// Consolidated: use the shared AbiRegistry from the MCP modules (scripts/arb-tx-tools/abi-registry.ts)
// This eliminates duplication of ABI scanning, selector indexing, and basic error decoding.
import {
  buildAbiRegistry,
  decodeRevert as sharedDecodeRevert,
  type AbiRegistry,
} from "../../../../scripts/arb-tx-tools/abi-registry.ts";

// Import project ABIs to pass as extras (source of truth for custom errors + swap calls)
import {
  EXECUTOR_ABI,
  EXECUTOR_AAVE_ABI,
  EXECUTOR_APPROVE_IF_NEEDED_ABI,
  V2_PAIR_SWAP_ABI,
  V3_POOL_SWAP_ABI,
  KYBER_ELASTIC_POOL_SWAP_ABI,
  DODO_SELL_BASE_ABI,
  DODO_SELL_QUOTE_ABI,
  WOOFI_ROUTER_SWAP_ABI,
  BALANCER_VAULT_SWAP_ABI,
  CURVE_EXCHANGE_INT128_ABI,
  CURVE_EXCHANGE_UINT256_ABI,
  CURVE_EXCHANGE_INT128_RECEIVER_ABI,
  POOL_MANAGER_LOCK_ABI,
  CALL_STRUCT_ARRAY_ABI,
  ERC20_TRANSFER_ABI,
} from "../../../../src/services/execution/calldata/abis.ts";

// HyperIndex abis dir for additional protocol ABIs
const HYPER_ABIS_DIR = path.resolve(import.meta.dir, "../../../../hyperindex/abis");

// Collect extras from the main abis.ts (they are already the ABI arrays)
const extraAbis: any[] = [
  EXECUTOR_ABI,
  EXECUTOR_AAVE_ABI,
  EXECUTOR_APPROVE_IF_NEEDED_ABI,
  V2_PAIR_SWAP_ABI,
  V3_POOL_SWAP_ABI,
  KYBER_ELASTIC_POOL_SWAP_ABI,
  DODO_SELL_BASE_ABI,
  DODO_SELL_QUOTE_ABI,
  WOOFI_ROUTER_SWAP_ABI,
  BALANCER_VAULT_SWAP_ABI,
  CURVE_EXCHANGE_INT128_ABI,
  CURVE_EXCHANGE_UINT256_ABI,
  CURVE_EXCHANGE_INT128_RECEIVER_ABI,
  POOL_MANAGER_LOCK_ABI,
  CALL_STRUCT_ARRAY_ABI,
  ERC20_TRANSFER_ABI,
].filter((a): a is any[] => Array.isArray(a));

// Build the registry (reuses the single source of truth for indexing functions + errors)
const abiRegistry: AbiRegistry = buildAbiRegistry(HYPER_ABIS_DIR, extraAbis);
const FULL_ABI = extraAbis.flat();

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else if (!args._cmd) {
      args._cmd = a;
    } else if (!args._arg1) {
      args._arg1 = a;
    }
  }
  return args;
}

function tryDecodeWithAbi(data: Hex) {
  // Use collected ABIs for function/error decode (viem direct). 
  // The abiRegistry (from shared buildAbiRegistry) provides indexed selectors/names for nicer output.
  const flatAbis = extraAbis.flat();
  try {
    const decoded = decodeFunctionData({ abi: flatAbis as any, data });
    return { kind: "function", ...decoded };
  } catch {}

  try {
    const decoded = decodeErrorResult({ abi: flatAbis as any, data });
    return { kind: "error", ...decoded };
  } catch {}

  return null;
}

function formatDecoded(d: any): string {
  if (!d) return "Unable to decode with known ABIs (try 4byte or provide custom ABI)";
  if (d.kind === "function") {
    return `Function: ${d.functionName}\nArgs: ${JSON.stringify(d.args, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`;
  }
  if (d.kind === "error") {
    return `Custom Error: ${d.errorName}\nArgs: ${JSON.stringify(d.args, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`;
  }
  return JSON.stringify(d, null, 2);
}

async function decodeInput(data: Hex) {
  console.log("=== Decoding TX Input Data ===");
  console.log("Data:", data);
  const res = tryDecodeWithAbi(data);
  console.log(formatDecoded(res));
  // Also show 4byte sig
  const sig = data.slice(0, 10);
  console.log(`\n4byte selector: ${sig}`);
}

async function decodeRevert(data: Hex, hint?: string) {
  console.log("=== Decoding Revert / Error Data ===");
  console.log("Data:", data);
  if (hint) console.log("Hint:", hint);

  // Prefer the consolidated shared decoder (from scripts/arb-tx-tools/abi-registry)
  try {
    const shared = await sharedDecodeRevert(data, abiRegistry);
    if (shared) {
      console.log(`Custom Error (shared): ${shared.name}`);
      console.log("Args:", JSON.stringify(shared.args, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      console.log("Signature:", shared.signature);
      return;
    }
  } catch {}

  const res = tryDecodeWithAbi(data);
  if (res) {
    console.log(formatDecoded(res));
    return;
  }

  // Common solidity string revert (Error(string))
  if (data.startsWith("0x08c379a0")) {
    try {
      // Simple decode for Error(string)
      const reasonHex = "0x" + data.slice(10 + 64); // after selector + offset
      // better: use viem but for minimal
      const len = parseInt(data.slice(74, 74 + 64), 16);
      const reason = Buffer.from(data.slice(74 + 64, 74 + 64 + len * 2), "hex").toString("utf8");
      console.log(`Solidity Error(string): "${reason}"`);
      return;
    } catch {}
  }

  // Panic
  if (data.startsWith("0x4e487b71")) {
    const code = parseInt(data.slice(10, 74), 16);
    const panics: Record<number, string> = {
      0x01: "assert",
      0x11: "overflow",
      0x12: "div0",
      0x21: "invalid enum",
      0x31: "pop empty",
      0x32: "index OOB",
      0x41: "alloc",
      0x51: "call",
      0x61: "assert",
    };
    console.log(`Panic(0x${code.toString(16)}): ${panics[code] || "unknown"}`);
    return;
  }

  console.log("No matching custom error or standard Error(string)/Panic. Raw data may be from external contract.");
}

async function getClient(rpcUrl?: string) {
  const url =
    rpcUrl ||
    process.env.POLYGON_RPC_URL ||
    process.env.POLYGON_RPC_URLS?.split(",")[0] ||
    process.env.ETH_RPC_URL ||
    "https://polygon-rpc.com";
  return createPublicClient({ chain: polygon, transport: http(url) });
}

async function decodeTx(hash: Hex, rpcUrl?: string) {
  console.log("=== Decoding Transaction ===");
  console.log("Hash:", hash);
  const client = await getClient(rpcUrl);
  const tx = await client.getTransaction({ hash });
  console.log("From:", tx.from, "To:", tx.to, "Value:", tx.value?.toString());
  if (tx.input && tx.input !== "0x") {
    await decodeInput(tx.input as Hex);
  }
}

async function decodeReceipt(hash: Hex, rpcUrl?: string) {
  console.log("=== Decoding Transaction Receipt & Logs ===");
  console.log("Hash:", hash);
  const client = await getClient(rpcUrl);
  const receipt = await client.getTransactionReceipt({ hash });
  console.log("Status:", receipt.status, "GasUsed:", receipt.gasUsed?.toString(), "Logs:", receipt.logs.length);

  if (receipt.status === "reverted") {
    console.log("\n--- TX REVERTED ---");
    // Try to get revert reason via trace or from input if possible (not always present)
    console.log("To get precise revert reason, also run: decode-revert with the revert data from trace or eth_call simulation.");
  }

  for (const [i, log] of receipt.logs.entries()) {
    console.log(`\nLog #${i}: ${log.address}`);
    try {
      const decoded = decodeEventLog({ abi: FULL_ABI as any, data: log.data, topics: log.topics as any });
      console.log(`  Event: ${decoded.eventName}`);
      console.log(
        `  Args:`,
        JSON.stringify(decoded.args, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
    } catch {
      console.log(`  (no ABI match) topics[0]=${log.topics?.[0]}`);
    }
  }
}

async function fourByte(sig: string) {
  console.log("=== 4byte lookup for selector ===");
  console.log("Selector:", sig);
  // Local only - for online, agent can use web_search or context
  console.log("Tip: For full signature database, use `cast 4byte ${sig}` (foundry) or search 4byte.directory");
  // Try to find in our ABIs
  const normalized = sig.toLowerCase().startsWith("0x") ? sig.toLowerCase() : "0x" + sig.toLowerCase();
  for (const item of FULL_ABI) {
    if (item.type === "function" || item.type === "error") {
      // rough - viem doesn't expose easily without full encode, so just note
    }
  }
  console.log("(Local ABI scan complete - no direct reverse map; use decode-input on full calldata instead)");
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = (args._cmd as string) || "help";

  try {
    if (cmd === "decode-input" || cmd === "input") {
      const data = (args.data || args._arg1) as Hex;
      if (!data) throw new Error("Missing --data 0x...");
      await decodeInput(data);
    } else if (cmd === "decode-revert" || cmd === "revert" || cmd === "error") {
      const data = (args.data || args._arg1) as Hex;
      if (!data) throw new Error("Missing --data 0x...");
      await decodeRevert(data, args.reason as string | undefined);
    } else if (cmd === "decode-tx" || cmd === "tx") {
      const hash = (args.hash || args._arg1) as Hex;
      if (!hash) throw new Error("Missing --hash 0x...");
      await decodeTx(hash, args.rpc as string | undefined);
    } else if (cmd === "decode-receipt" || cmd === "receipt" || cmd === "logs") {
      const hash = (args.hash || args._arg1) as Hex;
      if (!hash) throw new Error("Missing --hash 0x...");
      await decodeReceipt(hash, args.rpc as string | undefined);
    } else if (cmd === "4byte" || cmd === "selector") {
      await fourByte((args._arg1 || args.sig) as string);
    } else {
      console.log(`ABICoder - Arb Bot Transaction & Revert Decoder

Commands:
  decode-input --data 0x...                 Decode calldata (function or error)
  decode-revert --data 0x... [--reason]     Decode revert bytes (custom errors + Error + Panic)
  decode-tx --hash 0x... [--rpc URL]        Fetch + decode a tx input
  decode-receipt --hash 0x... [--rpc URL]   Fetch receipt + decode all logs
  4byte 0x12345678                          Show selector info

Examples:
  bun .grok/skills/arb-tx-tools/scripts/abicoder.ts decode-revert --data 0x...
  bun .grok/skills/arb-tx-tools/scripts/abicoder.ts decode-receipt --hash 0x123... --rpc $POLYGON_RPC_URL

Uses all ABIs from src/services/execution/calldata/abis.ts + hyperindex/abis/*.json
`);
    }
  } catch (e: any) {
    console.error("Error:", e.message || e);
    process.exit(1);
  }
}

main();
