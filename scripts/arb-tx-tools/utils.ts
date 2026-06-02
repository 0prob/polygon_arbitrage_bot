import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { defineChain } from "viem";

export function loadEnv(): Record<string, string> {
  try {
    const text = readProjectEnv();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env file is optional — tools degrade gracefully
  }
  return process.env as Record<string, string>;
}

function readProjectEnv(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== "/") {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf-8");
    }
    dir = dirname(dir);
  }
  return readFileSync(".env", "utf-8");
}

export function getRequiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}. Set it in .env or pass via --env-file.`);
  }
  return val;
}

export const polygonChain = defineChain({
  id: 137,
  name: "Polygon",
  network: "polygon",
  nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  rpcUrls: { default: { http: ["https://polygon-rpc.com"] } },
});
