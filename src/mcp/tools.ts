import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient } from "./daemon-client.js";

export function registerTools(server: McpServer, client: DaemonClient): void {
  server.tool(
    "agent_register",
    "Register this agent with the coordination daemon. Called automatically on startup.",
    { name: z.string().describe("Agent name"), worktree: z.string().describe("Worktree path") },
    async ({ name, worktree }) => {
      const { data } = await client.register(name, worktree);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "agent_deregister",
    "Unregister this agent and release all its locks.",
    {},
    async () => {
      const { data } = await client.deregister();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
        return {
          content: [{ type: "text", text: `CONFLICT: ${JSON.stringify(data, null, 2)}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "lock_release",
    "Release a lock you previously acquired.",
    { resource: z.string().describe("Resource identifier to release") },
    async ({ resource }) => {
      const { status, data } = await client.releaseLock(resource);
      if (status !== 200) {
        return {
          content: [{ type: "text", text: `ERROR: ${JSON.stringify(data, null, 2)}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "lock_list",
    "List all currently active locks across all agents.",
    {},
    async () => {
      const { data } = await client.getLocks();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "get_announcements",
    "View all active announcements from other agents.",
    {},
    async () => {
      const { data } = await client.getAnnouncements();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "resolve_issue",
    "Mark a reported issue as resolved.",
    { issueId: z.string().describe("Issue ID to resolve") },
    async ({ issueId }) => {
      const { status, data } = await client.resolveIssue(issueId);
      if (status !== 200) {
        return {
          content: [{ type: "text", text: `ERROR: ${JSON.stringify(data, null, 2)}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    "get_status",
    "Full coordination overview: all agents, locks, announcements, and open issues.",
    {},
    async () => {
      const { data } = await client.getStatus();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );
}
