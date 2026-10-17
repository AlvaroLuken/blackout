// Run the gateway over stdio in front of any stdio MCP server:
//   npx tsx src/mcp-gateway/cli.ts --config blackout.mcp.json
// Config: { "mission", "journal", "downstream": { "command", "args", "env" }, "sideEffects": { tool: rule } }
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGateway, type GatewayConfig } from "./gateway.ts";

const i = process.argv.indexOf("--config");
const cfg = JSON.parse(fs.readFileSync(i >= 0 ? process.argv[i + 1] : "blackout.mcp.json", "utf8")) as GatewayConfig & {
  downstream: { command: string; args?: string[]; env?: Record<string, string> };
};

const client = new Client({ name: "blackout-gateway", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: cfg.downstream.command, args: cfg.downstream.args ?? [], env: { ...process.env, ...(cfg.downstream.env ?? {}) } as Record<string, string> }));
const { server } = createGateway(client, cfg);
await server.connect(new StdioServerTransport());
