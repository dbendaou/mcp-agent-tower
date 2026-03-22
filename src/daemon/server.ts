import { createServer } from "node:http";
import { mkdirSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { State } from "./state.js";
import { createRequestHandler } from "./routes.js";
import { startCleanupInterval } from "./cleanup.js";
import {
  DEFAULT_PORT,
  STATE_DIR,
  PID_FILE,
  PORT_FILE,
  LOG_FILE,
  AUTO_SHUTDOWN_MS,
} from "../shared/config.js";

export function startDaemon(port: number = DEFAULT_PORT, foreground = false): void {
  mkdirSync(STATE_DIR, { recursive: true });

  const state = new State();

  function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (foreground) {
      process.stdout.write(line);
    } else {
      try {
        appendFileSync(LOG_FILE, line);
      } catch {
        // ignore log failures
      }
    }
  }

  const cleanupInterval = startCleanupInterval(state, log);

  const autoShutdownInterval = setInterval(() => {
    if (Date.now() - state.lastActivity > AUTO_SHUTDOWN_MS && state.agentCount === 0) {
      log("Auto-shutdown: no activity for 30 minutes");
      shutdown();
    }
  }, 60_000);

  function shutdown() {
    log("Shutting down...");
    clearInterval(cleanupInterval);
    clearInterval(autoShutdownInterval);
    server.close(() => {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      try { unlinkSync(PORT_FILE); } catch { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000);
  }

  const handler = createRequestHandler(state, shutdown);
  const server = createServer(handler);

  server.listen(port, "127.0.0.1", () => {
    writeFileSync(PID_FILE, String(process.pid));
    writeFileSync(PORT_FILE, String(port));
    log(`Daemon started on 127.0.0.1:${port} (PID ${process.pid})`);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
