import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

try {
  const rootDir = path.join(__dirname, "..");
  console.log("Compiling ArbExecutor.huff...");
  const bytecode = execSync("huffc sol/src/ArbExecutor.huff --bytecode", { cwd: rootDir, encoding: "utf-8" }).trim();
  
  if (!/^[0-9a-fA-F]+$/.test(bytecode) || bytecode.length % 2 !== 0) {
    throw new Error("Invalid bytecode generated (not even-length hex): " + bytecode.slice(0, 100));
  }

  const deployerCode = "// SPDX-License-Identifier: MIT\n" +
    "pragma solidity ^0.8.34;\n\n" +
    "library HuffDeployer {\n" +
    "    bytes constant BYTECODE = hex\"" + bytecode + "\";\n" +
    "}\n";

  const outputPath = path.join(__dirname, "../sol/test/HuffDeployer.sol");
  fs.writeFileSync(outputPath, deployerCode);
  console.log("Successfully generated " + outputPath);
} catch (error) {
  console.error("Failed to compile Huff contract:", error);
  process.exit(1);
}
