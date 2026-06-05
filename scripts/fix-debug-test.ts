import { readFileSync, writeFileSync } from "fs";

const logPath = "./data/failing-calldata.ndjson";
const content = readFileSync(logPath, "utf-8");
const lines = content.split("\n").filter(Boolean);

// Find the first line with calldata
let calldata = "";
for (const line of lines) {
  try {
    const obj = JSON.parse(line);
    if (obj.calldata && obj.calldata.startsWith("0x")) {
      calldata = obj.calldata.slice(2); // remove 0x
      break;
    }
  } catch {}
}

if (!calldata) {
  console.error("No calldata found in logs.");
  process.exit(1);
}

const testPath = "./sol/test/ArbExecutorDebug.t.sol";
let testContent = readFileSync(testPath, "utf-8");

// We want to replace line 46 with:
//         bytes memory data = hex"";
// but using the correct calldata hex.
// Let's replace the line starting with "        bytes memory data = hex" up to the semicolon.
const regex = /bytes memory data = hex"[a-fA-F0-9\n\s]+";/g;
if (testContent.match(regex)) {
  testContent = testContent.replace(regex, `bytes memory data = hex"${calldata}";`);
  writeFileSync(testPath, testContent, "utf-8");
  console.log("Successfully updated ArbExecutorDebug.t.sol with valid hex calldata!");
} else {
  // Let's do a more robust replacement by replacing the specific block
  const startIdx = testContent.indexOf('bytes memory data = hex"');
  if (startIdx !== -1) {
    const endIdx = testContent.indexOf('";', startIdx);
    if (endIdx !== -1) {
      testContent = testContent.slice(0, startIdx) + `bytes memory data = hex"${calldata}` + testContent.slice(endIdx);
      writeFileSync(testPath, testContent, "utf-8");
      console.log("Successfully updated ArbExecutorDebug.t.sol with fallback replacement!");
    } else {
      console.error("Could not find ending of hex string.");
    }
  } else {
    console.error("Could not find hex string start in test file.");
  }
}
