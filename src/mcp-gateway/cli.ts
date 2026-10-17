// Run the gateway over stdio in front of any stdio MCP server:
//   npx tsx src/mcp-gateway/cli.ts --config blackout.mcp.json
// Config: { "mission", "journal", "downstream": { "command", "args", "env" }, "sideEffects": { tool: rule } }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGateway, type GatewayConfig } from "./gateway.ts";

const i = process.argv.indexOf("--config");
const cfg = JSON.parse(fs.readFileSync(i >= 0 ? process.argv[i + 1] : "blackout.mcp.json", "utf8")) as GatewayConfig & {
  downstream: { command?: string; args?: string[]; env?: Record<string, string>; builtin?: "demo-mailer" };
};
// "builtin": "demo-mailer" runs the bundled demo server, so the example works with zero setup.
if (cfg.downstream.builtin === "demo-mailer") {
  cfg.downstream.command = process.execPath;
  cfg.downstream.args = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/blackout-mcp.js"), "demo-mailer"];
}

const client = new Client({ name: "blackout-gateway", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: cfg.downstream.command!, args: cfg.downstream.args ?? [], env: { ...process.env, ...(cfg.downstream.env ?? {}) } as Record<string, string> }));
const { server } = createGateway(client, cfg);
await server.connect(new StdioServerTransport());
