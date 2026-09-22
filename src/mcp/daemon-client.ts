import { request } from "node:http";
import { CLIENT_TIMEOUT_MS, DEFAULT_PORT } from "../shared/config.js";
import type { SessionCredentials } from "../shared/types.js";

export interface ClientResponse<T = unknown> { status: number; data: T }
export class DaemonClient {
  private port: number; private agentName: string; private agentWorktree: string;
  private session?: SessionCredentials;
  constructor(agentName: string, agentWorktree: string, port?: number) { this.agentName = agentName; this.agentWorktree = agentWorktree; this.port = port ?? DEFAULT_PORT; }
  get agentId(): string | undefined { return this.session?.agentId; }

  private fetch(method: string, path: string, body?: Record<string, unknown>): Promise<ClientResponse> { return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = request({ hostname: "127.0.0.1", port: this.port, path, method, headers: { "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}), ...(this.session ? { "x-agent-id": this.session.agentId, "x-agent-token": this.session.sessionToken } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => { const raw = Buffer.concat(chunks).toString(); let data: unknown = raw; try { data = raw ? JSON.parse(raw) : null; } catch { /* retain text */ } resolve({ status: res.statusCode ?? 500, data }); });
    });
    req.setTimeout(CLIENT_TIMEOUT_MS, () => req.destroy(new Error("Daemon request timed out"))); req.on("error", reject); if (payload) req.write(payload); req.end();
  }); }
  async isAlive() { try { return (await this.fetch("GET", "/health")).status === 200; } catch { return false; } }
  async register(name = this.agentName, worktree = this.agentWorktree): Promise<ClientResponse> {
    let response = await this.fetch("POST", "/agents/register", { name, worktree });
    if (response.status === 401 && this.session) { this.session = undefined; response = await this.fetch("POST", "/agents/register", { name, worktree }); }
    if (response.status === 200) { const wire = response.data as { agent: unknown; credentials: SessionCredentials }; this.session = wire.credentials; this.agentName = name; this.agentWorktree = worktree; return { status: 200, data: wire.agent }; }
    return response;
  }
  deregister() { return this.fetch("POST", "/agents/deregister"); }
  heartbeat() { return this.fetch("POST", "/agents/heartbeat"); }
  describe(skills: string[]) { return this.fetch("POST", "/agents/describe", { skills }); }
  agentsList() { return this.fetch("GET", "/agents"); }
  acquireLock(resource: string, reason: string, ttlMs?: number) { return this.fetch("POST", "/locks/acquire", { resource, reason, ttlMs }); }
  releaseLock(resource: string) { return this.fetch("POST", "/locks/release", { resource }); }
  getLocks() { return this.fetch("GET", "/locks"); }
  announce(message: string, ttlMs?: number) { return this.fetch("POST", "/announcements", { message, ttlMs }); }
  getAnnouncements() { return this.fetch("GET", "/announcements"); }
  reportIssue(title: string, description: string, severity?: string) { return this.fetch("POST", "/issues", { title, description, severity }); }
  resolveIssue(issueId: string) { return this.fetch("POST", "/issues/resolve", { issueId }); }
  getStatus() { return this.fetch("GET", "/status"); }
  ask(input: { to?: string; skill?: string; question: string; context?: Record<string, unknown>; ttlMs?: number; waitMs?: number }) { return this.fetch("POST", "/bus/ask", input); }
  inbox() { return this.fetch("GET", "/bus/inbox"); }
  reply(askId: string, answer: string, artifacts?: Array<{ type: string; content: unknown }>) { return this.fetch("POST", "/bus/reply", { askId, answer, artifacts }); }
  askStatus(askId: string, waitMs?: number) { return this.fetch("GET", `/bus/asks/${encodeURIComponent(askId)}?waitMs=${waitMs ?? 0}`); }
  async startupCheckin(name?: string, worktree?: string) { const registration = await this.register(name, worktree); if (registration.status !== 200) return { registration, status: registration }; return { registration, status: await this.getStatus() }; }
  shutdown() { return this.fetch("POST", "/shutdown"); }
}
