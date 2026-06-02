#!/usr/bin/env bun

/**
 * Dev script for starting Envio HyperIndex with reset flag
 */
import { spawn } from "child_process";
import { resolve } from "path";

// Get the API token from environment
const envioToken = process.env.ENVIO_API_TOKEN?.trim();

if (!envioToken) {
  console.warn("⚠️  No ENVIO_API_TOKEN provided. HyperIndex will be rate-limited.");
  console.warn("   Set ENVIO_API_TOKEN in .env for best performance.");
}

const hyperindexDir = resolve(import.meta.dirname, "..", "hyperindex");

// Prepare environment for child process
const env = {
  ...process.env,
};

if (envioToken) {
  env.ENVIO_API_TOKEN = envioToken;
}

console.log(`🔄 Starting Envio HyperIndex with RESET from: ${hyperindexDir}`);
if (envioToken) {
  console.log(`🔑 Using ENVIO_API_TOKEN: ${envioToken.slice(0, 8)}...`);
}

// Spawn the envio dev process with reset flag
const child = spawn("bunx", ["envio", "dev", "-r"], {
  cwd: hyperindexDir,
  stdio: "inherit", 
  env,
  shell: false,
});

// Handle process events
child.on("error", (err) => {
  console.error("❌ Failed to start Envio:", err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code !== 0) {
    console.error(`❌ Envio exited with code ${code} (signal: ${signal})`);
    process.exit(code || 1);
  }
  console.log("✅ Envio HyperIndex stopped gracefully");
});

// Handle cleanup on parent exit
process.on("SIGINT", () => {
  console.log("\n🛑 Stopping Envio HyperIndex...");
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});