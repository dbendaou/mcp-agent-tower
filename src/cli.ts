#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import {
  DEFAULT_PORT,
  PID_FILE,
  PORT_FILE,
  LOG_FILE,
} from "./shared/config.js";

function getDaemonPort(): number {
  try {
    return Number(readFileSync(PORT_FILE, "utf-8").trim());
  } catch {
    return DEFAULT_PORT;
  }
}

function getDaemonPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function httpGet(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function httpPost(port: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method: "POST" },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function getDaemonEntryPath(): string {
  return new URL("./daemon/entry.js", import.meta.url).pathname;
}

async function cmdStart() {
  const pid = getDaemonPid();
  if (pid) {
    console.log(`Daemon already running (PID ${pid})`);
    return;
  }

  const child = spawn(process.execPath, [getDaemonEntryPath()], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (getDaemonPid()) {
      console.log(`Daemon started (PID ${child.pid})`);
      return;
    }
  }
  console.error("Failed to start daemon");
  process.exit(1);
}

async function cmdStop() {
  const port = getDaemonPort();
  try {
    await httpPost(port, "/shutdown");
    console.log("Daemon stopped");
  } catch {
    const pid = getDaemonPid();
    if (pid) {
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to PID ${pid}`);
    } else {
      console.log("Daemon is not running");
    }
  }
}

async function cmdStatus() {
  const pid = getDaemonPid();
  if (!pid) {
    console.log("Daemon is not running");
    return;
  }

  const port = getDaemonPort();
  console.log(`Daemon running (PID ${pid}, port ${port})\n`);

  try {
    const status = (await httpGet(port, "/status")) as Record<string, unknown>;
    const agents = status.agents as Array<Record<string, unknown>>;
    const locks = status.locks as Array<Record<string, unknown>>;
    const announcements = status.announcements as Array<Record<string, unknown>>;
    const issues = status.issues as Array<Record<string, unknown>>;
    const uptime = Math.round((status.daemonUptime as number) / 1000);

    console.log(`Uptime: ${uptime}s`);
    console.log(`\nAgents (${agents.length}):`);
    if (agents.length === 0) console.log("  (none)");
    for (const a of agents) {
      console.log(`  - ${a.name} [${a.worktree}]`);
    }

    console.log(`\nLocks (${locks.length}):`);
    if (locks.length === 0) console.log("  (none)");
    for (const l of locks) {
      console.log(`  - ${l.resource} -> ${l.owner} (${l.reason || "no reason"})`);
    }

    console.log(`\nAnnouncements (${announcements.length}):`);
    if (announcements.length === 0) console.log("  (none)");
    for (const a of announcements) {
      console.log(`  - [${a.author}] ${a.message}`);
    }

    console.log(`\nOpen Issues (${issues.length}):`);
    if (issues.length === 0) console.log("  (none)");
    for (const i of issues) {
      console.log(`  - [${i.severity}] ${i.title}: ${i.description}`);
    }
  } catch {
    console.error("Could not connect to daemon");
  }
}

async function cmdDaemon() {
  const { startDaemon } = await import("./daemon/server.js");
  startDaemon(DEFAULT_PORT, true);
}

async function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found");
    return;
  }
  const child = spawn("tail", ["-f", "-n", "50", LOG_FILE], {
    stdio: "inherit",
  });
  process.on("SIGINT", () => child.kill());
}

const command = process.argv[2];

switch (command) {
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "status":
    cmdStatus();
    break;
  case "daemon":
    cmdDaemon();
    break;
  case "logs":
    cmdLogs();
    break;
  default:
    console.log("Usage: agent-coord <start|stop|status|daemon|logs>");
    process.exit(command ? 1 : 0);
}
