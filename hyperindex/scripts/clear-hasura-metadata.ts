#!/usr/bin/env bun
/**
 * Clears Hasura metadata.
 *
 * This is useful before running `envio dev -r` to avoid the common
 * "metadata-warnings" error from Envio when effect tables are already tracked.
 *
 * Usage:
 *   bun run clear-hasura
 *
 * Environment variables:
 *   HASURA_URL                        (default: http://localhost:8080)
 *   HASURA_GRAPHQL_ADMIN_SECRET       (or HASURA_SECRET)
 */

// Try to pick up secrets from common locations
const hasuraUrl = process.env.HASURA_URL ?? "http://localhost:8080";
const secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET ?? process.env.HASURA_SECRET ?? process.env.HASURA_ADMIN_SECRET ?? "";

const endpoint = `${hasuraUrl.replace(/\/$/, "")}/v1/metadata`;

async function clearMetadata() {
  console.log(`Clearing Hasura metadata at ${hasuraUrl} ...`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (secret) {
    headers["x-hasura-admin-secret"] = secret;
  } else {
    console.warn("No Hasura admin secret provided. Attempting unauthenticated request (may fail).");
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "clear_metadata",
        args: {},
      }),
    });

    const text = await res.text();

    if (!res.ok) {
      const isAccessDenied = text.includes("access-denied") || text.includes("admin only");

      if (isAccessDenied && !secret) {
        console.error(
          "Hasura rejected the request (admin only). Provide the admin secret via one of:\n" +
            "  bun --env-file=.env run clear-hasura\n" +
            "  HASURA_GRAPHQL_ADMIN_SECRET=your-secret bun run clear-hasura\n" +
            "  HASURA_SECRET=your-secret bun run clear-hasura",
        );
      } else {
        console.error(`Failed to clear metadata (HTTP ${res.status}):`, text);
      }
      process.exit(1);
    }

    // Hasura usually returns { message: "success" } or similar
    console.log("✅ Hasura metadata cleared successfully.");
    console.log("   You can now safely run: bun run dev:reset   (or bunx envio dev -r)");
  } catch (err) {
    console.error("Error clearing Hasura metadata:", err);
    process.exit(1);
  }
}

clearMetadata();
