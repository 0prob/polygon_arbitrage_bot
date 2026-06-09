import { decodeErrorResult } from "viem";
import { readFileSync } from "fs";

const EXECUTOR_ABI = [
  {
    type: "error",
    name: "TransferFailed",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ]
  }
];

const lines = readFileSync("data/failing-calldata.ndjson", "utf-8").split("\n").filter(Boolean);

for (const line of lines) {
  const data = JSON.parse(line);
  if (data.revertData && data.revertData.startsWith("0xbf182be8")) {
    try {
      const decoded = decodeErrorResult({
        abi: EXECUTOR_ABI,
        data: data.revertData
      });
      console.log(`Time: ${new Date(data.ts).toISOString()} | Route: ${data.routeKey}`);
      if (decoded.args) {
        console.log(`Error: ${decoded.errorName} | Token: ${decoded.args[0]} | To: ${decoded.args[1]} | Amount: ${decoded.args[2]}`);
      } else {
        console.log(`Error: ${decoded.errorName}`);
      }
      console.log("---");
    } catch (e) {
      console.log(`Failed to decode: ${data.revertData}`);
    }
  }
}
