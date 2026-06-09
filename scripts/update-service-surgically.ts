import { readFileSync, writeFileSync } from "node:fs";

const filePath = "src/services/mempool/service.ts";
let content = readFileSync(filePath, "utf-8");

const startBlock = "    const IGNORED_SELECTORS = new Set([";
const endBlock = "    const decoded = decodeSwapCalldata(tx.to as `0x${string}`, tx.input, this.knownPools);";

const startIdx = content.indexOf(startBlock);
const endIdx = content.indexOf(endBlock);

if (startIdx !== -1 && endIdx !== -1) {
  const replacement = `    const decoded = decodeSwapCalldata(tx.to as any, tx.input, this.knownPools, this.abiRegistry);`;
  content = content.slice(0, startIdx) + replacement + content.slice(endIdx + endBlock.length);
  
  // Also need to handle the follow-up logic which might reference SELECTORS or ROUTER_SELECTORS
  content = content.replace("!SELECTORS[selector]", "!this.abiRegistry.functions[selector]");
  
  // Remove unused imports/constants if any
  content = content.replace(", SELECTORS", "");

  writeFileSync(filePath, content, "utf-8");
  console.log("Successfully updated service.ts");
} else {
  console.error("Could not find start or end block", { startIdx, endIdx });
}
