import { buildAbiRegistry, decodeRevert } from "./arb-tx-tools/abi-registry.ts";
import { readFileSync, existsSync } from "fs";
import { decodeFunctionData } from "viem";

const SOL_ABI = "./sol/out/ArbExecutor.sol/ArbExecutor.json";
const HYPERINDEX_ABI_DIR = "./hyperindex/abis";

const extraAbis: any[] = [];
try {
  if (existsSync(SOL_ABI)) {
    const foundryOut = JSON.parse(readFileSync(SOL_ABI, "utf-8"));
    if (foundryOut.abi) extraAbis.push(foundryOut.abi);
  }
} catch (e) {
  console.log("Error loading SOL_ABI", e);
}

extraAbis.push([
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
]);

try {
  const abisModule = await import("./../src/services/execution/calldata/abis.ts");
  for (const val of Object.values(abisModule)) {
    if (Array.isArray(val) && val.length > 0) {
      extraAbis.push(val);
    }
  }
} catch (e) {
  console.log("Error loading src ABIs", e);
}

const abiRegistry = buildAbiRegistry(HYPERINDEX_ABI_DIR, extraAbis);
const FULL_ABI = extraAbis.flat();

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
    const revertData = obj.revertData;
    const calldata = obj.calldata;

    let flashAmtStr = "N/A";
    let call0AmtStr = "N/A";
    let errorDesc = "N/A";
    let tokensInfo = "";
    const detailedCalls: string[] = [];

    if (calldata && calldata !== "0x") {
      try {
        const decodedInput = decodeFunctionData({
          abi: FULL_ABI,
          data: calldata,
        });
        if (decodedInput.functionName === "executeArb" || decodedInput.functionName === "executeArbWithAave") {
          const [flashToken, flashAmount, params] = decodedInput.args as [string, bigint, any];
          flashAmtStr = (Number(flashAmount) / 1e18).toFixed(4);
          tokensInfo = `FlashToken: ${flashToken.slice(0, 8)} | ProfitToken: ${params.profitToken.slice(0, 8)}`;

          if (i === 665) {
            detailedCalls.push(`Function: ${decodedInput.functionName}`);
            detailedCalls.push(`Flash Token: ${flashToken}, Flash Amount: ${flashAmount}`);
            detailedCalls.push(`Min Profit: ${params.minProfit}, Deadline: ${params.deadline}`);
            detailedCalls.push(`Calls count: ${params.calls.length}`);
            for (let c = 0; c < params.calls.length; c++) {
              const call = params.calls[c];
              let decodedCallDesc = `Call #${c}: target=${call.target}, value=${call.value}`;
              try {
                const decodedCall = decodeFunctionData({
                  abi: FULL_ABI,
                  data: call.data,
                });
                decodedCallDesc += `, func=${decodedCall.functionName}, args=${JSON.stringify(decodedCall.args, (_key, value) =>
                  typeof value === "bigint" ? value.toString() : value,
                )}`;
              } catch {
                decodedCallDesc += `, dataRaw=${call.data.slice(0, 50)}...`;
              }
              detailedCalls.push("  " + decodedCallDesc);
            }
          }

          if (params.calls && params.calls.length > 0) {
            try {
              const decodedCall = decodeFunctionData({
                abi: FULL_ABI,
                data: params.calls[0].data,
              });
              if (decodedCall.functionName === "swap" && decodedCall.args) {
                const amtSpec = decodedCall.args[2] as bigint;
                call0AmtStr = (Number(amtSpec) / 1e18).toFixed(4);
              }
            } catch {}
          }
        }
      } catch {}
    }

    if (revertData && revertData !== "0x") {
      const decoded = await decodeRevert(revertData, abiRegistry);
      if (decoded) {
        if (decoded.name === "ExternalCallFailed" && decoded.args.reason) {
          const nestedData = decoded.args.reason as `0x${string}`;
          const nestedDecoded = await decodeRevert(nestedData, abiRegistry);
          if (nestedDecoded) {
            const args = nestedDecoded.args as any;
            if (nestedDecoded.name === "TransferFailed") {
              const amt = args.amount as bigint;
              errorDesc = `ExtCallFail[0] -> TransferFailed(${String(args.token).slice(0, 8)}, amount=${(Number(amt) / 1e18).toFixed(4)})`;
            } else if (nestedDecoded.name === "ERC20InsufficientBalance") {
              const bal = args.balance as bigint;
              const need = args.needed as bigint;
              errorDesc = `ExtCallFail[0] -> ERC20InsufficientBalance(sender=${String(args.sender).slice(0, 8)}, bal=${(Number(bal) / 1e18).toFixed(4)}, need=${(Number(need) / 1e18).toFixed(4)})`;
            } else {
              errorDesc = `ExtCallFail[0] -> ${nestedDecoded.name}`;
            }
          } else {
            errorDesc = `ExtCallFail[0] -> raw(${nestedData.slice(0, 10)})`;
          }
        } else if (decoded.name === "TransferFailed") {
          const args = decoded.args as any;
          const amt = args.amount as bigint;
          errorDesc = `TransferFailed(${String(args.token).slice(0, 8)}, amount=${(Number(amt) / 1e18).toFixed(4)})`;
        } else {
          errorDesc = decoded.name;
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
