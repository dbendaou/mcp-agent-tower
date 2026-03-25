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

  server.tool(
    "startup_checkin",
    "IMPORTANT: Call this at the start of every conversation. Registers this agent and returns full coordination status (other agents, locks, announcements, issues) in one call.",
    { name: z.string().describe("Agent name"), worktree: z.string().describe("Worktree path") },
    async ({ name, worktree }) => {
      const { registration, status } = await client.startupCheckin(name, worktree);
      agentRegistered = true;
      const result = {
        registered: registration.data,
        status: status.data,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "agent_register",
    "Register this agent with the coordination daemon. Called automatically on startup.",
    { name: z.string().describe("Agent name"), worktree: z.string().describe("Worktree path") },
    async ({ name, worktree }) => {
      const { data } = await client.register(name, worktree);
      agentRegistered = true;
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "agent_deregister",
    "Unregister this agent and release all its locks.",
    {},
    async () => {
      const { data } = await client.deregister();
      agentRegistered = false;
      return wrapResponse(JSON.stringify(data, null, 2));
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
      if (status === 409) {
        return wrapResponse(`CONFLICT: ${JSON.stringify(data, null, 2)}`, true);
      }
      return wrapResponse(JSON.stringify(data, null, 2));
    },
  );

  server.tool(
    "lock_release",
    "Release a lock you previously acquired.",
    { resource: z.string().describe("Resource identifier to release") },
    async ({ resource }) => {
      const { status, data } = await client.releaseLock(resource);
      if (status !== 200) {
        return wrapResponse(`ERROR: ${JSON.stringify(data, null, 2)}`, true);
      }
      return wrapResponse(JSON.stringify(data, null, 2));
    },
  );

  server.tool(
    "lock_list",
    "List all currently active locks across all agents.",
    {},
    async () => {
      const { data } = await client.getLocks();
      return wrapResponse(JSON.stringify(data, null, 2));
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
      const { data } = await client.announce(message, ttlMs);
      return wrapResponse(JSON.stringify(data, null, 2));
    },
  );

  server.tool(
    "get_announcements",
    "View all active announcements from other agents.",
    {},
    async () => {
      const { data } = await client.getAnnouncements();
      return wrapResponse(JSON.stringify(data, null, 2));
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
      const { data } = await client.reportIssue(title, description, severity);
      return wrapResponse(JSON.stringify(data, null, 2));
    },
  );

  server.tool(
    "resolve_issue",
    "Mark a reported issue as resolved.",
    { issueId: z.string().describe("Issue ID to resolve") },
    async ({ issueId }) => {
      const { status, data } = await client.resolveIssue(issueId);
      if (status !== 200) {
        return wrapResponse(`ERROR: ${JSON.stringify(data, null, 2)}`, true);
      }
      return wrapResponse(JSON.stringify(data, null, 2));
    },
  );

  server.tool(
    "get_status",
    "Full coordination overview: all agents, locks, announcements, and open issues.",
    {},
    async () => {
      const { data } = await client.getStatus();
      return wrapResponse(JSON.stringify(data, null, 2));
    },
  );
}
