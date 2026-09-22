import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { afterEach, beforeEach, test } from "node:test";
import { createRequestHandler } from "../daemon/routes.js";
import { State } from "../daemon/state.js";
import { DaemonClient } from "../mcp/daemon-client.js";
import type { Agent, AskResult } from "../shared/types.js";

let state: State; let server: ReturnType<typeof createServer>; let port: number;
beforeEach(async () => {
  state = new State(); server = createServer(createRequestHandler(state, () => {}));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
async function client(name: string, worktree: string) { const c = new DaemonClient(name, worktree, port); const r = await c.register(); assert.equal(r.status, 200); return c; }
function raw(path: string, headers: Record<string,string> = {}) { return new Promise<{status:number; body:string}>(resolve => { const req = request({ hostname:"127.0.0.1", port, path, headers }, res => { const chunks: Buffer[]=[]; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() })); }); req.end(); }); }

test("two clients complete a directed ask and requester polls a late result", async () => {
  const a = await client("agent", "/a"), b = await client("agent-b", "/b");
  const pending = await a.ask({ to: b.agentId, question: "who?", waitMs: 10 });
  assert.equal((pending.data as any).status, "pending");
  const askId = (pending.data as any).askId;
  assert.equal((await b.inbox()).status, 200);
  assert.equal((await b.reply(askId, "me")).status, 200);
  const final = await a.askStatus(askId, 100);
  assert.deepEqual([(final.data as any).status, (final.data as any).answer], ["answered", "me"]);
});

test("same-name sessions remain distinct and locks use immutable ownership", async () => {
  const a = await client("same", "/one"), b = await client("same", "/two");
  assert.notEqual(a.agentId, b.agentId);
  assert.equal((await a.acquireLock("db", "owner")).status, 200);
  assert.equal((await b.releaseLock("db")).status, 404);
  assert.equal((await a.releaseLock("db")).status, 200);
  await a.register("renamed", "/updated");
  const peers = (await b.agentsList()).data as any[];
  assert.equal(peers.find(x => x.agentId === a.agentId).worktree, "/updated");
});

test("credentials are required and never appear in public values", async () => {
  const a = await client("private", "/secret");
  const denied = await raw("/status", { "x-agent-id": a.agentId!, "x-agent-token": "wrong" });
  assert.equal(denied.status, 401); assert.doesNotMatch(denied.body, /sessionToken|wrong/);
  const status = await a.getStatus(); assert.equal(status.status, 200);
  assert.doesNotMatch(JSON.stringify(status.data), /sessionToken|x-agent-token/);
  assert.equal((await raw("/shutdown")).status, 401);
});

test("skill fan-out snapshots recipients, rejects outsiders, and first reply wins", async () => {
  const requester = await client("requester", "/r"), one = await client("one", "/1"), two = await client("two", "/2"), outsider = await client("out", "/o");
  await one.describe(["github.pr"]); await two.describe(["github.pr"]);
  const made = await requester.ask({ skill: "github.pr", question: "author?" }); const id = (made.data as any).askId;
  assert.equal(((await one.inbox()).data as any[]).length, 1); assert.equal(((await two.inbox()).data as any[]).length, 1);
  assert.equal((await outsider.reply(id, "hack")).status, 403);
  assert.equal((await one.reply(id, "alice")).status, 200);
  assert.equal((await two.reply(id, "bob")).status, 409);
  assert.equal((await requester.askStatus(id)).data && ((await requester.askStatus(id)).data as any).answer, "alice");
});

test("deadlines, no recipients, departure cancellation, and waiter wakeup are distinct", async () => {
  const a = await client("a", "/a"), b = await client("b", "/b");
  assert.equal((await a.ask({ skill: "missing", question: "x" })).status, 404);
  const expiring = await a.ask({ to: b.agentId, question: "soon", ttlMs: 100 }); const expId = (expiring.data as any).askId;
  await new Promise(r => setTimeout(r, 110));
  assert.equal(((await a.askStatus(expId)).data as any).status, "expired");
  const live = await a.ask({ to: b.agentId, question: "wait", ttlMs: 1000 }); const liveId = (live.data as any).askId;
  const waiting = a.askStatus(liveId, 1000); await b.deregister();
  assert.equal(((await waiting).data as any).status, "cancelled");
  const c = await client("c", "/c"); const timeoutAsk = await a.ask({ to: c.agentId, question: "later", ttlMs: 500, waitMs: 10 });
  assert.equal((timeoutAsk.data as any).status, "pending");
  assert.equal(((await a.askStatus((timeoutAsk.data as any).askId)).data as any).status, "pending");
});

test("stale cleanup cancels only when all snapshotted recipients leave", async () => {
  const a = await client("a", "/a"), b = await client("b", "/b"), c = await client("c", "/c"); await b.describe(["s"]); await c.describe(["s"]);
  const made = await a.ask({ skill: "s", question: "q" }); const id = (made.data as any).askId;
  await b.deregister(); assert.equal(((await a.askStatus(id)).data as any).status, "pending");
  await c.deregister(); assert.equal(((await a.askStatus(id)).data as any).status, "cancelled");
});

test("existing announcement, issue, status, and lock behavior remains available", async () => {
  const a = await client("legacy", "/legacy");
  assert.equal((await a.announce("deploying")).status, 200);
  assert.equal(((await a.getAnnouncements()).data as any[])[0].message, "deploying");
  assert.equal((await a.reportIssue("down", "service unavailable", "high")).status, 200);
  const status = (await a.getStatus()).data as any;
  assert.equal(status.issues[0].severity, "high"); assert.deepEqual(status.inbox, []);
  assert.equal((await a.acquireLock("port:1", "test", 1000)).status, 200);
  assert.equal(((await a.getLocks()).data as any[])[0].ownerId, a.agentId);
});

test("terminal ask retention is bounded", () => {
  const local = new State();
  const requester = local.registerAgent("r", "/r").agent;
  const recipient = local.registerAgent("p", "/p").agent;
  let oldest = "";
  for (let i = 0; i < 1001; i++) {
    const ask = local.createAsk(requester.agentId, { to: recipient.agentId, question: `q${i}` });
    if (i === 0) oldest = ask.askId;
    local.reply(recipient.agentId, ask.askId, "done");
  }
  // Creating another ask runs retention cleanup before adding the live record.
  local.createAsk(requester.agentId, { to: recipient.agentId, question: "trigger cleanup" });
  assert.throws(() => local.getAsk(requester.agentId, oldest), /Ask not found/);
});

function restartState() {
  // Keep the ephemeral port while replacing all daemon sessions and data.
  state = new State();
  server.removeAllListeners("request");
  server.on("request", createRequestHandler(state, () => {}));
}

test("explicit deregistration survives heartbeats until an explicit check-in", async () => {
  const a = await client("agent", "/a");
  const oldId = a.agentId;
  await a.deregister();
  assert.equal(a.agentId, undefined);
  for (let tick = 0; tick < 3; tick++) await a.heartbeat();
  assert.equal(state.agentCount, 0);
  const checkin = await a.startupCheckin("returned", "/new");
  assert.equal(checkin.registration.status, 200);
  assert.notEqual(a.agentId, oldId);
  await a.heartbeat();
  assert.equal(state.agentCount, 1);
  assert.equal(state.getAgents()[0].name, "returned");
});

test("deregistration wins over overlapping heartbeat recovery", async () => {
  const a = await client("agent", "/a");
  restartState();
  const recovering = a.heartbeat();
  const leaving = a.deregister();
  const nextTick = a.heartbeat();
  await Promise.all([recovering, leaving, nextTick]);
  assert.equal(state.agentCount, 0);
  assert.equal(a.agentId, undefined);
});

test("restart recovery restores only successfully advertised skills", async () => {
  const a = await client("requester", "/a"), b = await client("reviewer", "/b");
  const skills = ["github.pr"];
  assert.equal((await b.describe(skills)).status, 200);
  skills[0] = "caller-mutated";
  assert.equal((await b.describe([""])).status, 400);
  await b.acquireLock("old-lock", "not replayed");
  const oldId = b.agentId;
  restartState();
  await Promise.all([a.heartbeat(), b.heartbeat()]);
  assert.notEqual(b.agentId, oldId);
  assert.deepEqual(state.getLocks(), []);
  const peers = (await a.agentsList()).data as Agent[];
  assert.deepEqual(peers.find(peer => peer.agentId === b.agentId)?.skills, ["github.pr"]);
  const ask = (await a.ask({ skill: "github.pr", question: "author?" })).data as AskResult;
  assert.equal((await b.reply(ask.askId, "alice")).status, 200);
  assert.equal(((await a.askStatus(ask.askId)).data as AskResult).answer, "alice");

  // An intentional successful clear must also survive the next restart.
  assert.equal((await b.describe([])).status, 200);
  restartState();
  await Promise.all([a.heartbeat(), b.heartbeat()]);
  assert.equal((await a.ask({ skill: "github.pr", question: "author?" })).status, 404);
});

test("overlapping recovery and check-in reuse one session", async () => {
  const a = await client("agent", "/a");
  await a.describe(["code.review"]);
  restartState();
  await Promise.all([a.heartbeat(), a.startupCheckin("updated", "/updated"), a.heartbeat()]);
  assert.equal(state.agentCount, 1);
  assert.equal(state.getAgents()[0].agentId, a.agentId);
  assert.equal(state.getAgents()[0].name, "updated");
  assert.deepEqual(state.getAgents()[0].skills, ["code.review"]);
});

test("a failed skill restoration is retried on the next heartbeat", async () => {
  const a = await client("agent", "/a");
  await a.describe(["code.review"]);
  restartState();
  server.removeAllListeners("request");
  const handler = createRequestHandler(state, () => {});
  let rejectOnce = true;
  server.on("request", (req, res) => {
    if (req.url === "/agents/describe" && rejectOnce) {
      rejectOnce = false;
      req.resume();
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Temporarily unavailable" }));
    } else handler(req, res);
  });
  assert.equal((await a.heartbeat()).status, 503);
  assert.deepEqual(state.getAgents()[0].skills, []);
  const recoveredId = a.agentId;
  assert.equal((await a.heartbeat()).status, 200);
  assert.equal(a.agentId, recoveredId);
  assert.equal(state.agentCount, 1);
  assert.deepEqual(state.getAgents()[0].skills, ["code.review"]);
});

test("ask and result waits wake at TTL without polling or a cleanup sweep", { timeout: 3000 }, async () => {
  const a = await client("requester", "/a"), b = await client("recipient", "/b");
  const start = performance.now();
  const ask = await a.ask({ to: b.agentId, question: "expire", ttlMs: 100, waitMs: 10000 });
  assert.equal((ask.data as AskResult).status, "expired");
  assert(performance.now() - start < 1500, "creation wait must stop near TTL, not waitMs");

  const pending = (await a.ask({ to: b.agentId, question: "expire later", ttlMs: 100 })).data as AskResult;
  const pollStart = performance.now();
  const results = await Promise.all([a.askStatus(pending.askId, 10000), a.askStatus(pending.askId, 10000)]);
  for (const result of results) assert.equal((result.data as AskResult).status, "expired");
  assert(performance.now() - pollStart < 1500, "all result waiters must wake on expiry");
});

test("aborting a wait preserves the live ask for a later answer", async () => {
  const a = state.registerAgent("requester", "/a").agent;
  const b = state.registerAgent("recipient", "/b").agent;
  const ask = state.createAsk(a.agentId, { to: b.agentId, question: "keep alive" });
  const controller = new AbortController();
  const waiting = state.waitForAsk(a.agentId, ask.askId, 10000, controller.signal);
  controller.abort();
  assert.equal((await waiting).status, "pending");
  // A signal that was already aborted must not allocate another long-lived wait.
  assert.equal((await state.waitForAsk(a.agentId, ask.askId, 10000, controller.signal)).status, "pending");
  state.reply(b.agentId, ask.askId, "answer");
  assert.equal(state.getAsk(a.agentId, ask.askId).answer, "answer");
});
