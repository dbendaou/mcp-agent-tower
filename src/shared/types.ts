import { z } from "zod";
import {
  MAX_ASK_TTL_MS, MAX_CONTEXT_BYTES, MAX_MESSAGE_LENGTH, MAX_SKILLS,
  MAX_SKILL_LENGTH, MAX_WAIT_MS, MIN_ASK_TTL_MS,
} from "./config.js";

const boundedString = (max: number) => z.string().min(1).max(max);
export const AgentInfoSchema = z.object({ name: boundedString(100), worktree: boundedString(1000) });
export const SkillsSchema = z.array(boundedString(MAX_SKILL_LENGTH)).max(MAX_SKILLS).default([]);
export const LockAcquireSchema = z.object({ resource: boundedString(500), reason: z.string().max(2000).optional().default(""), ttlMs: z.number().int().positive().max(24 * 60 * 60_000).optional() });
export const LockReleaseSchema = z.object({ resource: boundedString(500) });
export const AnnounceSchema = z.object({ message: boundedString(MAX_MESSAGE_LENGTH), ttlMs: z.number().int().positive().max(24 * 60 * 60_000).optional() });
export const ReportIssueSchema = z.object({ title: boundedString(500), description: boundedString(MAX_MESSAGE_LENGTH), severity: z.enum(["low", "medium", "high", "critical"]).optional().default("medium") });
export const ResolveIssueSchema = z.object({ issueId: z.string().uuid().or(z.string().length(8)) });
export const AskSchema = z.object({
  to: z.string().uuid().optional(), skill: boundedString(MAX_SKILL_LENGTH).optional(),
  question: boundedString(MAX_MESSAGE_LENGTH), context: z.record(z.unknown()).optional(),
  ttlMs: z.number().int().min(MIN_ASK_TTL_MS).max(MAX_ASK_TTL_MS).optional(),
  waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
}).superRefine((v, ctx) => {
  if (!!v.to === !!v.skill) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Exactly one of to or skill is required" });
  if (v.context && Buffer.byteLength(JSON.stringify(v.context)) > MAX_CONTEXT_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "context is too large" });
});
export const ReplySchema = z.object({ askId: z.string().uuid(), answer: boundedString(MAX_MESSAGE_LENGTH), artifacts: z.array(z.object({ type: boundedString(100), content: z.unknown() })).max(20).optional() });

export interface Agent { agentId: string; name: string; worktree: string; skills: string[]; registeredAt: number; lastSeen: number; }
export interface SessionCredentials { agentId: string; sessionToken: string; }
export interface Lock { resource: string; ownerId: string; owner: string; ownerWorktree: string; reason: string; acquiredAt: number; expiresAt: number | null; }
export interface Announcement { id: string; author: string; message: string; createdAt: number; expiresAt: number | null; }
export interface Issue { id: string; reporter: string; title: string; description: string; severity: "low" | "medium" | "high" | "critical"; status: "open" | "resolved"; createdAt: number; resolvedAt: number | null; resolvedBy: string | null; }
export type AskStatus = "pending" | "answered" | "expired" | "cancelled";
export interface AskResult { askId: string; status: AskStatus; createdAt: number; expiresAt: number; answer?: string; artifacts?: Array<{ type: string; content: unknown }>; repliedBy?: Pick<Agent, "agentId" | "name" | "worktree">; }
export interface InboxAsk { askId: string; from: Pick<Agent, "agentId" | "name" | "worktree">; question: string; context?: Record<string, unknown>; createdAt: number; expiresAt: number; }
export interface CoordinationStatus { agents: Agent[]; locks: Lock[]; announcements: Announcement[]; issues: Issue[]; inbox?: InboxAsk[]; daemonUptime: number; }
