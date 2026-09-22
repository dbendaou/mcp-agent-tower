import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { MAX_BODY_BYTES, MAX_WAIT_MS } from "../shared/config.js";
import { AgentInfoSchema, AnnounceSchema, AskSchema, LockAcquireSchema, LockReleaseSchema, ReplySchema, ReportIssueSchema, ResolveIssueSchema, SkillsSchema } from "../shared/types.js";
import { StateError, type State } from "./state.js";

interface Response { status: number; data: unknown }
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> { return new Promise((resolve, reject) => {
  const chunks: Buffer[] = []; let size = 0;
  req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new StateError(413, "Request body too large")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => { if (size > MAX_BODY_BYTES) return; const raw = Buffer.concat(chunks).toString(); if (!raw) return resolve({}); try { const value: unknown = JSON.parse(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); resolve(value as Record<string, unknown>); } catch { reject(new StateError(400, "Invalid JSON object")); } }); req.on("error", reject);
}); }
function credentials(req: IncomingMessage) { return { agentId: typeof req.headers["x-agent-id"] === "string" ? req.headers["x-agent-id"] : undefined, token: typeof req.headers["x-agent-token"] === "string" ? req.headers["x-agent-token"] : undefined }; }
function send(res: ServerResponse, status: number, data: unknown) { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> { const result = schema.safeParse(body); if (!result.success) throw new StateError(400, result.error.issues.map(i => i.message).join("; ")); return result.data; }

export function createRequestHandler(state: State, onShutdown: () => void): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => { try {
    const method = req.method ?? "GET"; const url = new URL(req.url ?? "/", "http://localhost"); const path = url.pathname;
    if (method === "GET" && path === "/health") return send(res, 200, { ok: true, time: Date.now() });
    const body = method === "POST" ? await readBody(req) : {};
    if (method === "POST" && path === "/agents/register") {
      const info = parse(AgentInfoSchema, body); const c = credentials(req);
      const result = state.registerAgent(info.name, info.worktree, c.agentId || c.token ? { agentId: c.agentId ?? "", sessionToken: c.token ?? "" } : undefined);
      return send(res, 200, result);
    }
    const c = credentials(req); const agent = state.authenticate(c.agentId, c.token); agent.lastSeen = Date.now();
    let out: Response | undefined;
    if (method === "POST" && path === "/shutdown") { send(res, 200, { ok: true }); onShutdown(); return; }
    if (method === "POST" && path === "/agents/deregister") { state.deregisterAgent(agent.agentId); out = { status: 200, data: { ok: true } }; }
    else if (method === "POST" && path === "/agents/heartbeat") { state.heartbeat(agent.agentId); out = { status: 200, data: { ok: true } }; }
    else if (method === "POST" && path === "/agents/describe") { const skills = parse(z.object({ skills: SkillsSchema }), body).skills; out = { status: 200, data: state.describe(agent.agentId, skills) }; }
    else if (method === "GET" && path === "/agents") out = { status: 200, data: state.getAgents(agent.agentId) };
    else if (method === "POST" && path === "/locks/acquire") { const v = parse(LockAcquireSchema, body); const r = state.acquireLock(v.resource, agent.agentId, v.reason, v.ttlMs); out = r.ok ? { status: 200, data: r.lock } : { status: 409, data: { error: "Resource locked", holder: r.holder } }; }
    else if (method === "POST" && path === "/locks/release") { const v = parse(LockReleaseSchema, body); const ok = state.releaseLock(v.resource, agent.agentId); out = { status: ok ? 200 : 404, data: { ok, ...(ok ? {} : { error: "Lock not found or not owner" }) } }; }
    else if (method === "GET" && path === "/locks") out = { status: 200, data: state.getLocks() };
    else if (method === "POST" && path === "/announcements") { const v = parse(AnnounceSchema, body); out = { status: 200, data: state.addAnnouncement(agent.name, v.message, v.ttlMs) }; }
    else if (method === "GET" && path === "/announcements") out = { status: 200, data: state.getAnnouncements() };
    else if (method === "POST" && path === "/issues") { const v = parse(ReportIssueSchema, body); out = { status: 200, data: state.reportIssue(agent.name, v.title, v.description, v.severity) }; }
    else if (method === "POST" && path === "/issues/resolve") { const v = parse(ResolveIssueSchema, body); const issue = state.resolveIssue(v.issueId, agent.name); out = issue ? { status: 200, data: issue } : { status: 404, data: { error: "Issue not found" } }; }
    else if (method === "GET" && path === "/issues") out = { status: 200, data: state.getIssues() };
    else if (method === "GET" && path === "/status") out = { status: 200, data: state.getStatus(agent.agentId) };
    else if (method === "POST" && path === "/bus/ask") { const v = parse(AskSchema, body); const result = state.createAsk(agent.agentId, v); const controller = new AbortController(); const abort = () => controller.abort(); req.once("aborted", abort); res.once("close", abort); const waited = await state.waitForAsk(agent.agentId, result.askId, v.waitMs ?? 0, controller.signal); req.removeListener("aborted", abort); res.removeListener("close", abort); out = { status: 200, data: waited }; }
    else if (method === "GET" && path === "/bus/inbox") out = { status: 200, data: state.getInbox(agent.agentId) };
    else if (method === "POST" && path === "/bus/reply") { const v = parse(ReplySchema, body); out = { status: 200, data: state.reply(agent.agentId, v.askId, v.answer, v.artifacts as Array<{ type: string; content: unknown }> | undefined) }; }
    else if (method === "GET" && /^\/bus\/asks\/[^/]+$/.test(path)) { const askId = decodeURIComponent(path.slice("/bus/asks/".length)); const waitRaw = url.searchParams.get("waitMs") ?? "0"; if (!/^\d+$/.test(waitRaw)) throw new StateError(400, "waitMs must be a non-negative integer"); const waitMs = Number(waitRaw); if (waitMs > MAX_WAIT_MS) throw new StateError(400, `waitMs must be at most ${MAX_WAIT_MS}`); const controller = new AbortController(); const abort = () => controller.abort(); req.once("aborted", abort); res.once("close", abort); const result = await state.waitForAsk(agent.agentId, askId, waitMs, controller.signal); req.removeListener("aborted", abort); res.removeListener("close", abort); out = { status: 200, data: result }; }
    else out = { status: 404, data: { error: "Not found" } };
    send(res, out.status, out.data);
  } catch (err) { const status = err instanceof StateError ? err.status : err instanceof z.ZodError ? 400 : 500; send(res, status, { error: err instanceof Error ? err.message : "Internal error" }); }
  };
}
