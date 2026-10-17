#!/usr/bin/env node
// blackout-mcp: the Blackout MCP gateway on stdio.
//   blackout-mcp --config blackout.mcp.json   run the gateway in front of your MCP server
//   blackout-mcp demo-mailer                  a demo MCP mailer to try it with
//   blackout-mcp init                         write an example blackout.mcp.json here
import { register } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
process.removeAllListeners("warning"); // node:sqlite is experimental in Node 22; keep stdio clean
register();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cmd = process.argv[2];
if (cmd === "demo-mailer") {
  process.argv[1] = path.join(root, "src/mcp-gateway/demo-mailer.ts");
  await import(path.join(root, "src/mcp-gateway/demo-mailer.ts"));
} else if (cmd === "init") {
  const dest = path.resolve("blackout.mcp.json");
  if (fs.existsSync(dest)) { console.error(`${dest} already exists`); process.exit(1); }
  fs.copyFileSync(path.join(root, "examples/blackout.mcp.json"), dest);
  console.error(`wrote ${dest}`);
} else {
  await import(path.join(root, "src/mcp-gateway/cli.ts"));
}
