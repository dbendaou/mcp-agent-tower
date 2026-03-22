#!/usr/bin/env node

import { basename } from "node:path";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "./daemon-client.js";
import { registerTools } from "./tools.js";
import { DEFAULT_PORT, PORT_FILE, PID_FILE, STATE_DIR } from "../shared/config.js";

function parseArgs(): { name: string; worktree: string; port: number } {
  const args = process.argv.slice(2);
  let name = process.env.AGENT_TOWER_NAME ?? "";
  let worktree = process.cwd();
  let port = Number(process.env.AGENT_TOWER_PORT) || DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) name = args[++i];
    else if (args[i] === "--worktree" && args[i + 1]) worktree = args[++i];
    else if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
  }

  if (!name) {
    name = basename(worktree);
  }

  return { name, worktree, port };
}

function getDaemonPort(): number {
  try {
    return Number(readFileSync(PORT_FILE, "utf-8").trim());
  } catch {
    return DEFAULT_PORT;
  }
}

async function ensureDaemon(port: number): Promise<void> {
  const client = new DaemonClient("probe", "", port);
  if (await client.isAlive()) return;

  const daemonEntry = new URL("../daemon/entry.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [daemonEntry, String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await client.isAlive()) return;
  }
  throw new Error("Failed to start daemon");
}

async function main() {
  const { name, worktree, port } = parseArgs();

  await ensureDaemon(port);

  const client = new DaemonClient(name, worktree, port);

  await client.register();

  const heartbeatInterval = setInterval(async () => {
    try {
      await client.heartbeat();
    } catch {
      // daemon may be down, will reconnect
    }
  }, 30_000);

  const mcpServer = new McpServer({
    name: "agent-tower",
    version: "0.1.0",
  });

  registerTools(mcpServer, client);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  process.on("SIGTERM", async () => {
    clearInterval(heartbeatInterval);
    try { await client.deregister(); } catch { /* ignore */ }
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    clearInterval(heartbeatInterval);
    try { await client.deregister(); } catch { /* ignore */ }
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`agent-tower-mcp: ${err}\n`);
  process.exit(1);
});
