#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { loadEnv, polygonChain } from "./arb-tx-tools/utils.ts";
import { AbiRegistry } from "../src/core/abis/registry.ts";
import { COMPILED_ABIS } from "../src/core/abis/compiled/index.ts";
import { ARB_EXECUTOR_ABI } from "../src/core/abis/executor.ts";
import { AnvilManager } from "./arb-tx-tools/anvil-manager.ts";
import { LogCapture } from "./arb-tx-tools/log-capture.ts";
import { existsSync } from "fs";
import { createPublicClient, http, type Hex } from "viem";

loadEnv();

const registry = new AbiRegistry();
Object.entries(COMPILED_ABIS).forEach(([tag, abi]) => registry.registerAbi(abi, tag));
registry.registerAbi(ARB_EXECUTOR_ABI, "Executor");

let publicClient: ReturnType<typeof createPublicClient> | null = null;

function getClient() {
  if (!publicClient && process.env.POLYGON_RPC_URL) {
    publicClient = createPublicClient({
      chain: polygonChain,
      transport: http(process.env.POLYGON_RPC_URL),
    });
  }
  return publicClient;
}

const anvilManager = new AnvilManager();

const logCapture = new LogCapture(1000);

if (existsSync("data/runner.log")) {
  logCapture.startWatching("data/runner.log");
}

const originalWrite = process.stderr.write.bind(process.stderr);
(process.stderr.write as any) = function (chunk: any, ...args: any[]) {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  for (const line of text.split("\n").filter(Boolean)) {
    logCapture.push("ERROR", line);
  }
  return originalWrite(chunk, ...args);
} as typeof process.stderr.write;

const server = new Server({ name: "arb-tx-tools", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start-fork",
      description: "Start an Anvil fork of Polygon mainnet. Requires POLYGON_RPC_URL in .env.",
      inputSchema: {
        type: "object",
        properties: {
          forkBlockNumber: { type: "number", description: "Block number to fork at (default: latest)" },
          port: { type: "number", description: "Anvil listen port (default: 8545 or FORK_PORT env)" },
        },
      },
    },
    {
      name: "stop-fork",
      description: "Stop the running Anvil fork.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "simulate",
      description: "Execute eth_call simulation against the fork (or public RPC with publicRpc=true). Decodes custom errors automatically.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target contract address" },
          data: { type: "string", description: "Hex calldata" },
          from: { type: "string", description: "Sender address" },
          publicRpc: { type: "boolean", description: "Skip fork, use public archive RPC directly" },
        },
        required: ["to", "data"],
      },
    },
    {
      name: "simulate-arb",
      description:
        "Full flash-loan route simulation. Starts a fork and returns route details. Use simulate with constructed calldata for execution.",
      inputSchema: {
        type: "object",
        properties: {
          tokenIn: { type: "string", description: "Input token address" },
          tokenOut: { type: "string", description: "Output token address" },
          amountIn: { type: "string", description: "Flash principal in wei" },
          pools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dex: { type: "string" },
                address: { type: "string" },
                tokenIn: { type: "string" },
                tokenOut: { type: "string" },
                fee: { type: "number" },
              },
              required: ["dex", "address", "tokenIn", "tokenOut"],
            },
          },
          flashLoanSource: { type: "string", enum: ["balancer", "aave"] },
          forkBlockNumber: { type: "number" },
        },
        required: ["tokenIn", "tokenOut", "amountIn", "pools", "flashLoanSource"],
      },
    },
    {
      name: "decode-revert",
      description: "Decode raw revert bytes into human-readable error name + arguments.",
      inputSchema: {
        type: "object",
        properties: {
          data: { type: "string", description: "Hex revert data (e.g. 0x08c379a0...)" },
        },
        required: ["data"],
      },
    },
    {
      name: "decode-receipt",
      description: "Fetch and decode a transaction receipt (revert reason + all event logs).",
      inputSchema: {
        type: "object",
        properties: {
          hash: { type: "string", description: "Transaction hash" },
        },
        required: ["hash"],
      },
    },
    {
      name: "decode-input",
      description: "Decode raw calldata or transaction input into function name + arguments.",
      inputSchema: {
        type: "object",
        properties: {
          data: { type: "string", description: "Hex calldata" },
          hash: { type: "string", description: "Transaction hash (alternative to data)" },
        },
      },
    },
    {
      name: "get-logs",
      description: "Return recent log entries from the ring buffer. Supports filtering.",
      inputSchema: {
        type: "object",
        properties: {
          last: { type: "number", description: "Number of lines to return (default: 100)" },
          errorsOnly: { type: "boolean", description: "Only ERROR/FATAL entries" },
          filter: { type: "string", description: "Regex pattern to match against message" },
          since: { type: "string", description: "ISO timestamp, return entries after this time" },
        },
      },
    },
    {
      name: "follow",
      description: "Poll for new log entries since a given timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: "ISO timestamp cursor" },
        },
      },
    },
    {
      name: "errors",
      description: "Shorthand for get-logs with last=100, errorsOnly=true.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "status",
      description: "Quick health check — buffer stats, fork status.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "start-fork": {
        const info = await anvilManager.startFork({
          forkBlockNumber: args?.forkBlockNumber as number | undefined,
          port: args?.port as number | undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "stop-fork": {
        const result = await anvilManager.stopFork();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "simulate": {
        const rpcUrl = args?.publicRpc ? process.env.POLYGON_RPC_URL : anvilManager.isRunning() ? anvilManager.getInfo()!.rpcUrl : null;

        if (!rpcUrl) {
          if (!anvilManager.isRunning()) {
            throw new McpError(ErrorCode.InvalidRequest, "No fork running. Call start-fork first, or set publicRpc=true.");
          }
          throw new McpError(ErrorCode.InvalidRequest, "POLYGON_RPC_URL not set.");
        }

        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
              {
                to: args?.to,
                data: args?.data,
                from: (args?.from as string) ?? undefined,
              },
              "latest",
            ],
          }),
        });

        const json = await response.json();
        if (json.error) {
          const revertData = json.error.data ?? json.error.message?.match(/0x[a-fA-F0-9]{8,}/)?.[0];
          if (revertData) {
            const decoded = registry.decodeError(revertData as Hex);
            if (decoded) {
              return { content: [{ type: "text", text: JSON.stringify({ success: false, revert: decoded }, null, 2) }] };
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: json.error.message }, null, 2) }] };
        }

        return { content: [{ type: "text", text: JSON.stringify({ success: true, data: json.result }, null, 2) }] };
      }

      case "simulate-arb": {
        const forkInfo = await anvilManager.startFork({
          forkBlockNumber: args?.forkBlockNumber as number | undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message: "Fork is running. Use 'simulate' with the calldata from the bot's builder to test your route.",
                  fork: forkInfo,
                  route: {
                    tokenIn: args?.tokenIn,
                    tokenOut: args?.tokenOut,
                    amountIn: args?.amountIn,
                    pools: args?.pools,
                    flashLoanSource: args?.flashLoanSource,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "decode-revert": {
        const data = (args as any).data as Hex;
        const decoded = registry.decodeError(data);
        if (decoded) {
          return { content: [{ type: "text", text: JSON.stringify(decoded, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ name: "UnknownError", args: {}, selector: data.slice(0, 10) }) }] };
      }

      case "decode-receipt": {
        const client = getClient();
        if (!client) throw new McpError(ErrorCode.InvalidRequest, "POLYGON_RPC_URL not set");
        const hash = (args as any).hash as `0x${string}`;

        const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);

        const result: Record<string, unknown> = {
          txHash: hash,
          status: receipt.status === "success" ? "success" : "revert",
        };

        if (receipt.status === "reverted") {
          try {
            const callResult = await client.call({
              to: tx.to!,
              data: tx.input,
              account: tx.from,
              blockNumber: receipt.blockNumber,
            });
            if (callResult) {
              const decoded = registry.decodeError(callResult as Hex);
              if (decoded) result.revert = decoded;
            }
          } catch (e: any) {
            const match = e.message?.match?.(/0x[a-fA-F0-9]{8,}/);
            if (match) {
              const decoded = registry.decodeError(match[0] as Hex);
              if (decoded) result.revert = decoded;
            }
          }
        }

        const logs = receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
        }));
        result.logs = logs;

        if (tx.input && tx.input !== "0x") {
          const decoded = registry.decodeCall(tx.input as Hex);
          if (decoded) {
            (result as any).function = decoded.functionName;
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "decode-input": {
        let inputData: Hex;
        if ((args as any).hash) {
          const client = getClient();
          if (!client) throw new McpError(ErrorCode.InvalidRequest, "POLYGON_RPC_URL not set");
          const tx = await client.getTransaction({ hash: (args as any).hash });
          inputData = tx.input;
        } else if ((args as any).data) {
          inputData = (args as any).data;
        } else {
          throw new McpError(ErrorCode.InvalidParams, "Provide either 'hash' or 'data'");
        }

        const decoded = registry.decodeCall(inputData);
        if (!decoded) {
          return { content: [{ type: "text", text: JSON.stringify({ selector: inputData.slice(0, 10), function: "Unknown", args: {} }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ selector: inputData.slice(0, 10), function: decoded.functionName, args: decoded.args }) }] };
      }

      case "get-logs": {
        const opts = args as any;
        const entries = logCapture.getLogs({
          last: opts?.last ?? 100,
          errorsOnly: opts?.errorsOnly,
          filter: opts?.filter,
          since: opts?.since,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  entries: entries.map((e) => ({ timestamp: e.timestamp, level: e.level, message: e.message })),
                  total: logCapture.getAll().length,
                  errorCount: logCapture.errorCount,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "follow": {
        const since = (args as any)?.since;
        const entries = logCapture.getLogs({ since, last: 200 });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ entries, cursor: entries.length > 0 ? entries[entries.length - 1].timestamp : null }),
            },
          ],
        };
      }

      case "errors": {
        const entries = logCapture.getLogs({ last: 100, errorsOnly: true });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ entries, total: logCapture.getAll().length, errorCount: logCapture.errorCount }),
            },
          ],
        };
      }

      case "status": {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...logCapture.getStatus(),
                  forkRunning: anvilManager.isRunning(),
                  forkInfo: anvilManager.getInfo(),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
