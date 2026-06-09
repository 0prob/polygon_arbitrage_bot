import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { type Hex } from "viem";
import { AbiRegistry } from "../src/core/abis/registry.ts";
import { ARB_EXECUTOR_ABI } from "../src/core/abis/executor.ts";
import { COMPILED_ABIS } from "../src/core/abis/compiled/index.ts";

const SOL_ABI = "./sol/out/ArbExecutor.sol/ArbExecutor.json";
const HYPERINDEX_ABI_DIR = "./hyperindex/abis";

const abiRegistry = new AbiRegistry();

// 1. Register centralized ABIs
abiRegistry.registerAbi(ARB_EXECUTOR_ABI as any, "executor");
for (const [tag, abi] of Object.entries(COMPILED_ABIS)) {
  abiRegistry.registerAbi(abi as any, tag);
}

// 2. Load hyperindex abis (optional override/supplement)
if (existsSync(HYPERINDEX_ABI_DIR)) {
  const files = readdirSync(HYPERINDEX_ABI_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const abi = JSON.parse(readFileSync(join(HYPERINDEX_ABI_DIR, file), "utf-8"));
    abiRegistry.registerAbi(abi, basename(file, ".json"));
  }
}

// 3. Load sol abi (optional override/supplement)
try {
  if (existsSync(SOL_ABI)) {
    const foundryOut = JSON.parse(readFileSync(SOL_ABI, "utf-8"));
    if (foundryOut.abi) abiRegistry.registerAbi(foundryOut.abi, "executor_sol");
  }
} catch (e) {
  // console.log("Error loading SOL_ABI", e);
}

// 4. Add extra errors
abiRegistry.registerAbi([
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
], "common_errors");

const logPath = "./data/failing-calldata.ndjson";
if (!existsSync(logPath)) {
  console.error("Log file not found:", logPath);
  process.exit(1);
}

const content = readFileSync(logPath, "utf-8");
const lines = content.split("\n").filter(Boolean);

console.log(`Analyzing all ${lines.length} failing txs...`);

for (let i = 0; i < lines.length; i++) {
  try {
    const obj = JSON.parse(lines[i]);
    const revertData = obj.revertData as Hex;
    const calldata = obj.calldata as Hex;

    let flashAmtStr = "N/A";
    let call0AmtStr = "N/A";
    let errorDesc = "N/A";
    let tokensInfo = "";
    const detailedCalls: string[] = [];

    if (calldata && calldata !== "0x") {
      const decodedInput = abiRegistry.decodeCall(calldata);
      if (decodedInput) {
        if (decodedInput.functionName === "executeArb" || decodedInput.functionName === "executeArbWithAave") {
          const [flashToken, flashAmount, params] = decodedInput.args as [string, bigint, any];
          flashAmtStr = (Number(flashAmount) / 1e18).toFixed(4);
          tokensInfo = `FlashToken: ${flashToken.slice(0, 8)} | ProfitToken: ${params.profitToken.slice(0, 8)}`;

            detailedCalls.push(`Function: ${decodedInput.functionName}`);
            detailedCalls.push(`Flash Token: ${flashToken}, Flash Amount: ${flashAmount}`);
            detailedCalls.push(`Min Profit: ${params.minProfit}, Deadline: ${params.deadline}`);
            detailedCalls.push(`Calls count: ${params.calls.length}`);
            for (let c = 0; c < params.calls.length; c++) {
              const call = params.calls[c];
              let decodedCallDesc = `Call #${c}: target=${call.target}, value=${call.value}`;
              const decodedCall = abiRegistry.decodeCall(call.data);
              if (decodedCall) {
                decodedCallDesc += `, func=${decodedCall.functionName}, args=${JSON.stringify(decodedCall.args, (_key, value) =>
                  typeof value === "bigint" ? value.toString() : value,
                )}`;
              } else {
                decodedCallDesc += `, dataRaw=${call.data.slice(0, 50)}...`;
              }
              detailedCalls.push("  " + decodedCallDesc);
            }

          if (params.calls && params.calls.length > 0) {
            const decodedCall = abiRegistry.decodeCall(params.calls[0].data);
            if (decodedCall && decodedCall.functionName === "swap" && decodedCall.args) {
              const amtSpec = decodedCall.args[2] as bigint;
              call0AmtStr = (Number(amtSpec) / 1e18).toFixed(4);
            }
          }
        }
      }
    }

    if (revertData && revertData !== "0x") {
      const decoded = abiRegistry.decodeError(revertData);
      if (decoded) {
        if (decoded.errorName === "ExternalCallFailed" && decoded.args && (decoded.args as any).reason) {
          const nestedData = (decoded.args as any).reason as Hex;
          const nestedDecoded = abiRegistry.decodeError(nestedData);
          if (nestedDecoded) {
            const args = nestedDecoded.args as any;
            if (nestedDecoded.errorName === "TransferFailed") {
              const amt = args.amount as bigint;
              errorDesc = `ExtCallFail[0] -> TransferFailed(${String(args.token).slice(0, 8)}, amount=${(Number(amt) / 1e18).toFixed(4)})`;
            } else if (nestedDecoded.errorName === "ERC20InsufficientBalance") {
              const bal = args.balance as bigint;
              const need = args.needed as bigint;
              errorDesc = `ExtCallFail[0] -> ERC20InsufficientBalance(sender=${String(args.sender).slice(0, 8)}, bal=${(Number(bal) / 1e18).toFixed(4)}, need=${(Number(need) / 1e18).toFixed(4)})`;
            } else {
              errorDesc = `ExtCallFail[0] -> ${nestedDecoded.errorName}`;
            }
          } else {
            errorDesc = `ExtCallFail[0] -> raw(${nestedData.slice(0, 10)})`;
          }
        } else if (decoded.errorName === "TransferFailed") {
          const args = decoded.args as any;
          const amt = args.amount as bigint;
          errorDesc = `TransferFailed(${String(args.token).slice(0, 8)}, amount=${(Number(amt) / 1e18).toFixed(4)})`;
        } else {
          errorDesc = decoded.errorName;
        }
      }
    }

    console.log(
      `Tx #${i.toString().padStart(2)} | Flash: ${flashAmtStr.padStart(8)} | Call0 SwapAmt: ${call0AmtStr.padStart(8)} | ${tokensInfo.padEnd(50)} | Error: ${errorDesc}`,
    );
    if (detailedCalls.length > 0) {
      console.log("Detailed Calls:\n" + detailedCalls.join("\n"));
      console.log("--------------------------------------------------------------------------------");
    }
  } catch (err: any) {
    console.error(`Error parsing line:`, err.message);
  }
}
