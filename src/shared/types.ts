import { z } from "zod";

export const AgentInfoSchema = z.object({
  name: z.string().min(1),
  worktree: z.string().min(1),
});

export const LockAcquireSchema = z.object({
  resource: z.string().min(1),
  reason: z.string().optional().default(""),
  ttlMs: z.number().int().positive().optional(),
});

export const LockReleaseSchema = z.object({
  resource: z.string().min(1),
});

export const AnnounceSchema = z.object({
  message: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});

export const ReportIssueSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
});

export const ResolveIssueSchema = z.object({
  issueId: z.string().min(1),
});

export interface Agent {
  name: string;
  worktree: string;
  registeredAt: number;
  lastSeen: number;
}

export interface Lock {
  resource: string;
  owner: string;
  ownerWorktree: string;
  reason: string;
  acquiredAt: number;
  expiresAt: number | null;
}

export interface Announcement {
  id: string;
  author: string;
  message: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface Issue {
  id: string;
  reporter: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "resolved";
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface CoordinationStatus {
  agents: Agent[];
  locks: Lock[];
  announcements: Announcement[];
  issues: Issue[];
  daemonUptime: number;
}
