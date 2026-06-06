#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getFunctionSelector } from "viem";

const apiKey = process.env.ETHERSCAN_API_KEY || "SBQM4MQY9KVENBCRFAAWFWCM96T5W1YQZ7";
const dataDir = "data";
const unknownSelectorsPath = join(dataDir, "unknown-selectors.json");

interface UnknownSelector {
  selector: string;
  count: number;
  sampleTx: string;
  sampleTo: string;
  firstSeen: string;
  lastSeen: string;
}

function isArbitrageNeeded(signature: string): boolean {
  const sigLower = signature.toLowerCase();

  // These are typical swap/exchange keywords
  const swapKeywords = ["swap", "exchange", "trade", "buy", "sell", "exactinput", "exactoutput", "execute"];
  // These are typical non-arbitrage/noise keywords
  const noiseKeywords = [
    "transfer",
    "approve",
    "claim",
    "deposit",
    "withdraw",
    "stake",
    "unstake",
    "mint",
    "burn",
    "governance",
    "vote",
    "set",
    "initialize",
  ];

  // Check noise first
  for (const kw of noiseKeywords) {
    if (sigLower.includes(kw)) return false;
  }

  // Check swap keywords
  for (const kw of swapKeywords) {
    if (sigLower.includes(kw)) return true;
  }

  return false;
}

async function resolveWithOpenChain(selector: string): Promise<string | null> {
  try {
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const json = await response.json();
    if (json.ok && json.result?.function?.[selector]) {
      const list = json.result.function[selector];
      if (Array.isArray(list) && list.length > 0) {
        // Find the one that doesn't contain obvious garbage
        const valid = list.filter((item: any) => !item.name.includes("_attention_"));
        if (valid.length > 0) return valid[0].name;
        return list[0].name;
      }
    }
  } catch (err) {
    console.error(`OpenChain lookup error for ${selector}:`, err);
  }
  return null;
}

async function resolveWithPolygonscan(selector: string, address: string): Promise<string | null> {
  if (!address || address === "0x" || address.length < 42) return null;
  try {
    const url = `https://api.polygonscan.com/api?module=contract&action=getabi&address=${address}&apikey=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const json = await response.json();
    if (json.status === "1" && json.result) {
      const abi = JSON.parse(json.result);
      for (const item of abi) {
        if (item.type === "function") {
          const inputs = item.inputs.map((inp: any) => inp.type).join(",");
          const signature = `${item.name}(${inputs})`;
          try {
            const itemSelector = getFunctionSelector(signature);
            if (itemSelector.toLowerCase() === selector.toLowerCase()) {
              return signature;
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error(`Polygonscan lookup error for ${selector} on address ${address}:`, err);
  }
  return null;
}

function updateDecoderFile(selector: string, signature: string): void {
  const filePath = "src/services/mempool/decoder.ts";
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return;
  }

  let content = readFileSync(filePath, "utf8");
  if (content.includes(selector)) {
    console.log(`Selector ${selector} already present in ${filePath}`);
    return;
  }

  const targetLine = "export const SELECTORS: Record<string, string> = {";
  const index = content.indexOf(targetLine);
  if (index === -1) {
    console.error(`Could not find SELECTORS definition in ${filePath}`);
    return;
  }

  const insertIndex = index + targetLine.length;
  const newLine = `\n  "${selector}": "OTHER", // ${signature}`;
  content = content.slice(0, insertIndex) + newLine + content.slice(insertIndex);

  writeFileSync(filePath, content, "utf8");
  console.log(`Successfully added ${selector} (${signature}) to ${filePath}`);
}

function updateServiceFile(selector: string, signature: string): void {
  const filePath = "src/services/mempool/service.ts";
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return;
  }

  let content = readFileSync(filePath, "utf8");
  if (content.includes(selector)) {
    console.log(`Selector ${selector} already present in ${filePath}`);
    return;
  }

  const targetLine = "    const IGNORED_SELECTORS = new Set([";
  const index = content.indexOf(targetLine);
  if (index === -1) {
    console.error(`Could not find IGNORED_SELECTORS definition in ${filePath}`);
    return;
  }

  const insertIndex = index + targetLine.length;
  const newLine = `\n      "${selector}", // ${signature}`;
  content = content.slice(0, insertIndex) + newLine + content.slice(insertIndex);

  writeFileSync(filePath, content, "utf8");
  console.log(`Successfully added ${selector} (${signature}) to ${filePath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const targets: { selector: string; to?: string }[] = [];

  if (args.length > 0) {
    // Support command line args: resolve-selectors <selector> [<sampleTo>]
    const selector = args[0].toLowerCase();
    if (!selector.startsWith("0x") || selector.length !== 10) {
      console.error("Invalid selector argument. Must be in 0x12345678 format.");
      process.exit(1);
    }
    targets.push({ selector, to: args[1] });
  } else {
    // Read from unknown-selectors.json
    if (!existsSync(unknownSelectorsPath)) {
      console.log(`No unknown selectors file found at ${unknownSelectorsPath}. Provide selector as argument to run manually.`);
      process.exit(0);
    }
    const raw = readFileSync(unknownSelectorsPath, "utf8");
    const data = JSON.parse(raw) as Record<string, UnknownSelector>;
    for (const [sel, item] of Object.entries(data)) {
      targets.push({ selector: sel, to: item.sampleTo });
    }
  }

  console.log(`Resolving ${targets.length} selectors...`);

  for (const target of targets) {
    const { selector, to } = target;
    console.log(`\nResolving selector: ${selector}...`);

    let signature = await resolveWithOpenChain(selector);
    if (signature) {
      console.log(`Resolved via OpenChain: ${signature}`);
    } else if (to) {
      console.log(`Not found in OpenChain. Querying Polygonscan for address ${to}...`);
      signature = await resolveWithPolygonscan(selector, to);
      if (signature) {
        console.log(`Resolved via Polygonscan: ${signature}`);
      }
    }

    if (!signature) {
      console.log(`Could not resolve selector: ${selector}`);
      continue;
    }

    const isArbitrage = isArbitrageNeeded(signature);
    console.log(`Arbitrage relevant: ${isArbitrage ? "YES" : "NO"}`);

    if (isArbitrage) {
      updateDecoderFile(selector, signature);
    } else {
      updateServiceFile(selector, signature);
    }
  }

  console.log("\nFinished processing all target selectors.");
}

main().catch((err) => {
  console.error("Unhandled error:", err);
});
