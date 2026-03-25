import { request } from "node:http";
import { DEFAULT_PORT } from "../shared/config.js";

export class DaemonClient {
  private port: number;
  private agentName: string;
  private agentWorktree: string;

  constructor(agentName: string, agentWorktree: string, port?: number) {
    this.agentName = agentName;
    this.agentWorktree = agentWorktree;
    this.port = port ?? DEFAULT_PORT;
  }

  private fetch(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path,
          method,
          headers: {
            "Content-Type": "application/json",
            "x-agent-name": this.agentName,
            "x-agent-worktree": this.agentWorktree,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            try {
              resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw) });
            } catch {
              resolve({ status: res.statusCode ?? 500, data: raw });
            }
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async isAlive(): Promise<boolean> {
    try {
      const { status } = await this.fetch("GET", "/health");
      return status === 200;
    } catch {
      return false;
    }
  }

  register(name?: string, worktree?: string) {
    return this.fetch("POST", "/agents/register", {
      name: name ?? this.agentName,
      worktree: worktree ?? this.agentWorktree,
    });
  }

  deregister() {
    return this.fetch("POST", "/agents/deregister");
  }

  heartbeat() {
    return this.fetch("POST", "/agents/heartbeat");
  }

  acquireLock(resource: string, reason: string, ttlMs?: number) {
    return this.fetch("POST", "/locks/acquire", { resource, reason, ttlMs });
  }

  releaseLock(resource: string) {
    return this.fetch("POST", "/locks/release", { resource });
  }

  getLocks() {
    return this.fetch("GET", "/locks");
  }

  announce(message: string, ttlMs?: number) {
    return this.fetch("POST", "/announcements", { message, ttlMs });
  }

  getAnnouncements() {
    return this.fetch("GET", "/announcements");
  }

  reportIssue(title: string, description: string, severity?: string) {
    return this.fetch("POST", "/issues", { title, description, severity });
  }

  resolveIssue(issueId: string) {
    return this.fetch("POST", "/issues/resolve", { issueId });
  }

  getStatus() {
    return this.fetch("GET", "/status");
  }

  async startupCheckin(name?: string, worktree?: string): Promise<{
    registration: { status: number; data: unknown };
    status: { status: number; data: unknown };
  }> {
    const registration = await this.register(name, worktree);
    const status = await this.getStatus();
    return { registration, status };
  }

  shutdown() {
    return this.fetch("POST", "/shutdown");
  }
}
