import { Database } from "bun:sqlite";
import { STATIC_TOKEN_DECIMALS } from "../src/effects/token_registry.js";
import path from "node:path";

const dbPath = path.resolve("hyperindex/token_registry.db");
const db = new Database(dbPath);

db.run("CREATE TABLE IF NOT EXISTS token_decimals (address TEXT PRIMARY KEY, decimals INTEGER)");

const insert = db.prepare("INSERT OR REPLACE INTO token_decimals (address, decimals) VALUES (?, ?)");
const transaction = db.transaction((tokens) => {
  for (const [address, decimals] of Object.entries(tokens)) {
    insert.run(address.toLowerCase(), decimals);
  }
});

transaction(STATIC_TOKEN_DECIMALS);
console.log(`Migrated ${Object.keys(STATIC_TOKEN_DECIMALS).length} tokens to ${dbPath}`);
