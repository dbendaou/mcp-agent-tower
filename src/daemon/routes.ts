import type { IncomingMessage, ServerResponse } from "node:http";
import type { State } from "./state.js";

type Handler = (
  state: State,
  body: Record<string, unknown>,
  agentName: string,
  agentWorktree: string,
) => { status: number; data: unknown };

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const routes: Record<string, Record<string, Handler>> = {
  POST: {
    "/agents/register": (state, body, name, worktree) => {
      const agent = state.registerAgent(
        (body.name as string) || name,
        (body.worktree as string) || worktree,
      );
      return { status: 200, data: agent };
    },
    "/agents/deregister": (state, _body, name) => {
      state.deregisterAgent(name);
      return { status: 200, data: { ok: true } };
    },
    "/agents/heartbeat": (state, _body, name) => {
      const ok = state.heartbeat(name);
      return { status: ok ? 200 : 404, data: { ok } };
    },
    "/locks/acquire": (state, body, name, worktree) => {
      const result = state.acquireLock(
        body.resource as string,
        name,
        worktree,
        (body.reason as string) || "",
        body.ttlMs as number | undefined,
      );
      if (result.ok) {
        return { status: 200, data: result.lock };
      }
      return { status: 409, data: { error: "Resource locked", holder: result.holder } };
    },
    "/locks/release": (state, body, name) => {
      const ok = state.releaseLock(body.resource as string, name);
      return {
        status: ok ? 200 : 404,
        data: { ok, error: ok ? undefined : "Lock not found or not owner" },
      };
    },
    "/announcements": (state, body, name) => {
      const ann = state.addAnnouncement(
        name,
        body.message as string,
        body.ttlMs as number | undefined,
      );
      return { status: 200, data: ann };
    },
    "/issues": (state, body, name) => {
      const issue = state.reportIssue(
        name,
        body.title as string,
        body.description as string,
        (body.severity as "low" | "medium" | "high" | "critical") || "medium",
      );
      return { status: 200, data: issue };
    },
    "/issues/resolve": (state, body, name) => {
      const issue = state.resolveIssue(body.issueId as string, name);
      if (!issue) return { status: 404, data: { error: "Issue not found" } };
      return { status: 200, data: issue };
    },
  },
  GET: {
    "/agents": (state) => ({ status: 200, data: state.getAgents() }),
    "/locks": (state) => ({ status: 200, data: state.getLocks() }),
    "/announcements": (state) => ({ status: 200, data: state.getAnnouncements() }),
    "/issues": (state) => ({ status: 200, data: state.getIssues() }),
    "/status": (state) => ({ status: 200, data: state.getStatus() }),
    "/health": () => ({ status: 200, data: { ok: true, time: Date.now() } }),
  },
};

export function createRequestHandler(
  state: State,
  onShutdown: () => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "POST" && url === "/shutdown") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      onShutdown();
      return;
    }

    const handler = routes[method]?.[url];
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      const body = method === "POST" ? await readBody(req) : {};
      const agentName = (req.headers["x-agent-name"] as string) || "unknown";
      const agentWorktree = (req.headers["x-agent-worktree"] as string) || "";
      const { status, data } = handler(state, body, agentName, agentWorktree);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  };
}
