import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_ANNOUNCEMENT_TTL_MS, DEFAULT_ASK_TTL_MS, DEFAULT_LOCK_TTL_MS,
  MAX_AUDIT_EVENTS, MAX_PENDING_ASKS, MAX_TERMINAL_ASKS, TERMINAL_RETENTION_MS,
} from "../shared/config.js";
import type { Agent, Announcement, AskResult, CoordinationStatus, InboxAsk, Issue, Lock, SessionCredentials } from "../shared/types.js";

interface AskRecord extends AskResult {
  requesterId: string; recipientIds: Set<string>; question: string;
  context?: Record<string, unknown>; terminalAt?: number;
}
interface AuditEvent { at: number; action: string; actorId: string; subjectId?: string; }
export class StateError extends Error { constructor(public status: number, message: string) { super(message); } }

export class State {
  private agents = new Map<string, Agent>();
  // Credentials deliberately live separately from public agent records.
  private credentials = new Map<string, string>();
  private locks = new Map<string, Lock>();
  private announcements = new Map<string, Announcement>();
  private issues = new Map<string, Issue>();
  private asks = new Map<string, AskRecord>();
  private waiters = new Map<string, Set<() => void>>();
  private audit: AuditEvent[] = [];
  private startedAt = Date.now();
  lastActivity = Date.now();

  private touch() { this.lastActivity = Date.now(); }
  private record(action: string, actorId: string, subjectId?: string) {
    this.audit.push({ at: Date.now(), action, actorId, subjectId });
    if (this.audit.length > MAX_AUDIT_EVENTS) this.audit.splice(0, this.audit.length - MAX_AUDIT_EVENTS);
  }
  private publicAgent(agent: Agent): Agent { return { ...agent, skills: [...agent.skills] }; }

  registerAgent(name: string, worktree: string, credentials?: SessionCredentials): { agent: Agent; credentials: SessionCredentials } {
    this.touch();
    if (credentials) {
      const current = this.authenticate(credentials.agentId, credentials.sessionToken);
      current.name = name; current.worktree = worktree; current.lastSeen = Date.now();
      this.record("register.update", current.agentId);
      return { agent: this.publicAgent(current), credentials };
    }
    const agentId = randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    const agent: Agent = { agentId, name, worktree, skills: [], registeredAt: now, lastSeen: now };
    this.agents.set(agentId, agent); this.credentials.set(agentId, sessionToken);
    this.record("register", agentId);
    return { agent: this.publicAgent(agent), credentials: { agentId, sessionToken } };
  }

  authenticate(agentId?: string, token?: string): Agent {
    if (!agentId || !token) throw new StateError(401, "Missing session credentials");
    const expected = this.credentials.get(agentId);
    if (!expected) throw new StateError(401, "Invalid or expired session");
    const a = Buffer.from(expected), b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new StateError(401, "Invalid or expired session");
    const agent = this.agents.get(agentId);
    if (!agent) throw new StateError(401, "Invalid or expired session");
    return agent;
  }

  deregisterAgent(agentId: string): void { this.touch(); this.removeAgent(agentId); }
  private removeAgent(agentId: string): void {
    this.agents.delete(agentId); this.credentials.delete(agentId);
    for (const [resource, lock] of this.locks) if (lock.ownerId === agentId) this.locks.delete(resource);
    for (const ask of this.asks.values()) {
      if (ask.status !== "pending") continue;
      if (ask.requesterId === agentId) this.finishAsk(ask, "cancelled");
      else if (ask.recipientIds.delete(agentId) && ask.recipientIds.size === 0) this.finishAsk(ask, "cancelled");
    }
    this.record("deregister", agentId);
  }
  heartbeat(agentId: string): void { this.touch(); this.agents.get(agentId)!.lastSeen = Date.now(); }
  describe(agentId: string, skills: string[]): Agent { this.touch(); const a = this.agents.get(agentId)!; a.skills = [...new Set(skills)]; a.lastSeen = Date.now(); this.record("describe", agentId); return this.publicAgent(a); }
  getAgents(excludeId?: string): Agent[] { return [...this.agents.values()].filter(a => a.agentId !== excludeId).map(a => this.publicAgent(a)); }

  acquireLock(resource: string, ownerId: string, reason: string, ttlMs?: number): { ok: true; lock: Lock } | { ok: false; holder: Lock } {
    this.touch(); const owner = this.agents.get(ownerId)!; const existing = this.locks.get(resource);
    if (existing && (!existing.expiresAt || existing.expiresAt >= Date.now())) return { ok: false, holder: existing };
    if (existing) this.locks.delete(resource);
    const now = Date.now(); const lock: Lock = { resource, ownerId, owner: owner.name, ownerWorktree: owner.worktree, reason, acquiredAt: now, expiresAt: now + (ttlMs ?? DEFAULT_LOCK_TTL_MS) };
    this.locks.set(resource, lock); return { ok: true, lock };
  }
  releaseLock(resource: string, ownerId: string): boolean { this.touch(); const lock = this.locks.get(resource); if (!lock || lock.ownerId !== ownerId) return false; return this.locks.delete(resource); }
  getLocks(): Lock[] { return [...this.locks.values()]; }
  addAnnouncement(author: string, message: string, ttlMs?: number): Announcement { this.touch(); const now = Date.now(); const a = { id: randomUUID().slice(0, 8), author, message, createdAt: now, expiresAt: now + (ttlMs ?? DEFAULT_ANNOUNCEMENT_TTL_MS) }; this.announcements.set(a.id, a); return a; }
  getAnnouncements(): Announcement[] { return [...this.announcements.values()]; }
  reportIssue(reporter: string, title: string, description: string, severity: Issue["severity"]): Issue { this.touch(); const i: Issue = { id: randomUUID().slice(0, 8), reporter, title, description, severity, status: "open", createdAt: Date.now(), resolvedAt: null, resolvedBy: null }; this.issues.set(i.id, i); return i; }
  resolveIssue(issueId: string, resolvedBy: string): Issue | null { this.touch(); const i = this.issues.get(issueId); if (!i) return null; i.status = "resolved"; i.resolvedAt = Date.now(); i.resolvedBy = resolvedBy; return i; }
  getIssues(): Issue[] { return [...this.issues.values()]; }

  createAsk(requesterId: string, input: { to?: string; skill?: string; question: string; context?: Record<string, unknown>; ttlMs?: number }): AskResult {
    this.touch(); this.sweepAsks();
    const pending = [...this.asks.values()].filter(a => a.status === "pending").length;
    if (pending >= MAX_PENDING_ASKS) throw new StateError(429, "Ask queue is full");
    let recipients: Agent[];
    if (input.to) { const target = this.agents.get(input.to); recipients = target && target.agentId !== requesterId ? [target] : []; }
    else recipients = [...this.agents.values()].filter(a => a.agentId !== requesterId && a.skills.includes(input.skill!));
    if (!recipients.length) throw new StateError(404, "No eligible live recipients");
    const now = Date.now(); const ask: AskRecord = { askId: randomUUID(), status: "pending", requesterId, recipientIds: new Set(recipients.map(r => r.agentId)), question: input.question, context: input.context, createdAt: now, expiresAt: now + (input.ttlMs ?? DEFAULT_ASK_TTL_MS) };
    this.asks.set(ask.askId, ask); this.record("ask", requesterId, ask.askId); return this.result(ask);
  }
  private expireIfNeeded(ask: AskRecord) { if (ask.status === "pending" && Date.now() >= ask.expiresAt) this.finishAsk(ask, "expired"); }
  private finishAsk(ask: AskRecord, status: AskRecord["status"]) { if (ask.status !== "pending") return; ask.status = status; ask.terminalAt = Date.now(); const callbacks = this.waiters.get(ask.askId); this.waiters.delete(ask.askId); callbacks?.forEach(fn => fn()); }
  private result(a: AskRecord): AskResult { const { askId, status, createdAt, expiresAt, answer, artifacts, repliedBy } = a; return { askId, status, createdAt, expiresAt, ...(answer !== undefined ? { answer } : {}), ...(artifacts ? { artifacts } : {}), ...(repliedBy ? { repliedBy } : {}) }; }
  getAsk(requesterId: string, askId: string): AskResult { const a = this.asks.get(askId); if (!a) throw new StateError(404, "Ask not found"); if (a.requesterId !== requesterId) throw new StateError(403, "Only the requester may view this ask"); this.expireIfNeeded(a); return this.result(a); }
  async waitForAsk(requesterId: string, askId: string, waitMs: number, signal?: AbortSignal): Promise<AskResult> {
    const initial = this.getAsk(requesterId, askId); if (initial.status !== "pending" || waitMs === 0) return initial;
    await new Promise<void>(resolve => {
      const callbacks = this.waiters.get(askId) ?? new Set(); let timer: NodeJS.Timeout;
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); callbacks.delete(done); if (!callbacks.size) this.waiters.delete(askId); resolve(); };
      callbacks.add(done); this.waiters.set(askId, callbacks); timer = setTimeout(done, waitMs); signal?.addEventListener("abort", done, { once: true });
    });
    return this.getAsk(requesterId, askId);
  }
  getInbox(recipientId: string): InboxAsk[] { this.sweepAsks(); return [...this.asks.values()].filter(a => a.status === "pending" && a.recipientIds.has(recipientId)).map(a => ({ askId: a.askId, from: this.agentSummary(a.requesterId), question: a.question, ...(a.context ? { context: a.context } : {}), createdAt: a.createdAt, expiresAt: a.expiresAt })); }
  reply(recipientId: string, askId: string, answer: string, artifacts?: AskResult["artifacts"]): AskResult {
    this.touch(); const a = this.asks.get(askId); if (!a) throw new StateError(404, "Ask not found"); this.expireIfNeeded(a);
    if (!a.recipientIds.has(recipientId)) throw new StateError(403, "Agent is not an assigned recipient");
    if (a.status !== "pending") throw new StateError(409, `Ask is already ${a.status}`);
    a.answer = answer; a.artifacts = artifacts; a.repliedBy = this.agentSummary(recipientId); this.finishAsk(a, "answered"); this.record("reply", recipientId, askId); return this.result(a);
  }
  private agentSummary(id: string) { const a = this.agents.get(id); if (!a) return { agentId: id, name: "departed", worktree: "" }; return { agentId: a.agentId, name: a.name, worktree: a.worktree }; }
  getStatus(callerId?: string): CoordinationStatus { return { agents: this.getAgents(callerId), locks: this.getLocks(), announcements: this.getAnnouncements(), issues: this.getIssues().filter(i => i.status === "open"), ...(callerId ? { inbox: this.getInbox(callerId) } : {}), daemonUptime: Date.now() - this.startedAt }; }
  private sweepAsks() { const now = Date.now(); for (const a of this.asks.values()) this.expireIfNeeded(a); const terminal = [...this.asks.values()].filter(a => a.status !== "pending").sort((a,b) => (a.terminalAt ?? 0) - (b.terminalAt ?? 0)); for (const a of terminal.filter(a => a.terminalAt! + TERMINAL_RETENTION_MS <= now)) { this.asks.delete(a.askId); terminal.splice(terminal.indexOf(a), 1); } while (terminal.length > MAX_TERMINAL_ASKS) this.asks.delete(terminal.shift()!.askId); }
  cleanup(staleTimeoutMs: number) { const now = Date.now(), removedAgents: string[] = [], removedLocks: string[] = [], removedAnnouncements: string[] = [];
    for (const a of [...this.agents.values()]) if (now - a.lastSeen > staleTimeoutMs) { removedAgents.push(a.agentId); this.removeAgent(a.agentId); }
    for (const [r,l] of this.locks) if (l.expiresAt && l.expiresAt <= now) { this.locks.delete(r); removedLocks.push(r); }
    for (const [id,a] of this.announcements) if (a.expiresAt && a.expiresAt <= now) { this.announcements.delete(id); removedAnnouncements.push(id); }
    this.sweepAsks(); return { removedAgents, removedLocks, removedAnnouncements };
  }
  get agentCount() { return this.agents.size; }
}
