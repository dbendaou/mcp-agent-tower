import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient } from "./daemon-client.js";

export function registerTools(server: McpServer, client: DaemonClient): void {
  let agentRegistered = false;

  const REGISTRATION_WARNING =
    "⚠️ You haven't called agent_register or startup_checkin yet. Register first so other agents know you exist.";

  function wrapResponse(text: string, isError?: boolean): { content: { type: "text"; text: string }[]; isError?: boolean } {
    const prefix = agentRegistered ? "" : REGISTRATION_WARNING + "\n\n";
    return {
      content: [{ type: "text" as const, text: prefix + text }],
      ...(isError ? { isError } : {}),
    };
  }

  function result(response: { status: number; data: unknown }) {
    const error = response.status < 200 || response.status >= 300;
    return wrapResponse(`${error ? `ERROR ${response.status}: ` : ""}${JSON.stringify(response.data, null, 2)}`, error);
  }

  server.tool(
    "startup_checkin",
    "IMPORTANT: Call this at the start of every conversation. Registers this agent and returns full coordination status (other agents, locks, announcements, issues) in one call.",
    { name: z.string().describe("Agent name"), worktree: z.string().describe("Worktree path") },
    async ({ name, worktree }) => {
      const { registration, status } = await client.startupCheckin(name, worktree);
      agentRegistered = registration.status === 200;
      const result = {
        registered: registration.data,
        status: status.data,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], ...(agentRegistered ? {} : { isError: true }) };
    },
  );

  server.tool(
    "agent_register",
    "Register this agent with the coordination daemon. Called automatically on startup.",
    { name: z.string().describe("Agent name"), worktree: z.string().describe("Worktree path") },
    async ({ name, worktree }) => {
      const response = await client.register(name, worktree);
      agentRegistered = response.status === 200;
      return result(response);
    },
  );

  server.tool(
    "agent_deregister",
    "Unregister this agent and release all its locks.",
    {},
    async () => {
      const response = await client.deregister();
      agentRegistered = false;
      return result(response);
    },
  );

  server.tool(
    "lock_acquire",
    "Acquire an exclusive lock on a shared resource (e.g. 'supabase-db', 'port-3000'). Returns 409 if already locked with holder details.",
    {
      resource: z.string().describe("Resource identifier to lock"),
      reason: z.string().optional().describe("Why you need this lock"),
      ttlMs: z.number().optional().describe("Lock TTL in milliseconds (default: 10 min)"),
    },
    async ({ resource, reason, ttlMs }) => {
      const { status, data } = await client.acquireLock(resource, reason ?? "", ttlMs);
      return result({ status, data });
    },
  );

  server.tool(
    "lock_release",
    "Release a lock you previously acquired.",
    { resource: z.string().describe("Resource identifier to release") },
    async ({ resource }) => {
      const { status, data } = await client.releaseLock(resource);
      return result({ status, data });
    },
  );

  server.tool(
    "lock_list",
    "List all currently active locks across all agents.",
    {},
    async () => {
      return result(await client.getLocks());
    },
  );

  server.tool(
    "announce",
    "Broadcast an announcement to all agents (e.g. 'DB reset in progress', 'deploying to staging').",
    {
      message: z.string().describe("Announcement message"),
      ttlMs: z.number().optional().describe("How long to keep (default: 30 min)"),
    },
    async ({ message, ttlMs }) => {
      return result(await client.announce(message, ttlMs));
    },
  );

  server.tool(
    "get_announcements",
    "View all active announcements from other agents.",
    {},
    async () => {
      return result(await client.getAnnouncements());
    },
  );

  server.tool(
    "report_issue",
    "Report a shared issue (e.g. 'Supabase is down', 'port 3000 in use by unknown process').",
    {
      title: z.string().describe("Short issue title"),
      description: z.string().describe("Detailed description"),
      severity: z.enum(["low", "medium", "high", "critical"]).optional().describe("Severity level"),
    },
    async ({ title, description, severity }) => {
      return result(await client.reportIssue(title, description, severity));
    },
  );

  server.tool(
    "resolve_issue",
    "Mark a reported issue as resolved.",
    { issueId: z.string().describe("Issue ID to resolve") },
    async ({ issueId }) => {
      const { status, data } = await client.resolveIssue(issueId);
      return result({ status, data });
    },
  );

  server.tool(
    "get_status",
    "Full coordination overview: all agents, locks, announcements, and open issues.",
    {},
    async () => {
      return result(await client.getStatus());
    },
  );

  server.tool("agent_describe", "Advertise the skills this agent can answer asks for.", { skills: z.array(z.string().min(1).max(100)).max(32) }, async ({ skills }) => result(await client.describe(skills)));
  server.tool("agents_list", "List live peer sessions and their advertised skills.", {}, async () => result(await client.agentsList()));
  server.tool("agent_ask", "Ask one agent ID or all live agents with a skill. A wait timeout returns pending; the ask remains live until its TTL.", {
    to: z.string().uuid().optional(), skill: z.string().min(1).max(100).optional(), question: z.string().min(1).max(16000), context: z.record(z.unknown()).optional(), ttlMs: z.number().int().min(100).max(600000).optional(), waitMs: z.number().int().min(0).max(30000).optional(),
  }, async (input) => result(await client.ask(input)));
  server.tool("agent_ask_status", "Get a previous ask result. Only its requester can poll it; optional waiting is bounded.", { askId: z.string().uuid(), waitMs: z.number().int().min(0).max(30000).optional() }, async ({ askId, waitMs }) => result(await client.askStatus(askId, waitMs)));
  server.tool("agent_inbox", "List pending asks assigned to this agent.", {}, async () => result(await client.inbox()));
  server.tool("agent_reply", "Reply to an assigned ask. The first valid reply wins.", { askId: z.string().uuid(), answer: z.string().min(1).max(16000), artifacts: z.array(z.object({ type: z.string().min(1).max(100), content: z.unknown() })).max(20).optional() }, async ({ askId, answer, artifacts }) => result(await client.reply(askId, answer, artifacts as Array<{ type: string; content: unknown }> | undefined)));
  server.tool("agent_broadcast", "Broadcast through the existing announcement board.", { message: z.string().min(1).max(16000), ttlMs: z.number().int().positive().optional() }, async ({ message, ttlMs }) => result(await client.announce(message, ttlMs)));
}
