import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 7420;
export const STATE_DIR = join(homedir(), ".agent-tower");
export const PID_FILE = join(STATE_DIR, "daemon.pid");
export const PORT_FILE = join(STATE_DIR, "daemon.port");
export const LOG_FILE = join(STATE_DIR, "daemon.log");

export const CLEANUP_INTERVAL_MS = 30_000;
export const AGENT_STALE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_LOCK_TTL_MS = 10 * 60_000;
export const DEFAULT_ANNOUNCEMENT_TTL_MS = 30 * 60_000;
export const AUTO_SHUTDOWN_MS = 30 * 60_000;
