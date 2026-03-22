import { randomUUID } from "node:crypto";
import {
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_ANNOUNCEMENT_TTL_MS,
} from "../shared/config.js";
import type {
  Agent,
  Lock,
  Announcement,
  Issue,
  CoordinationStatus,
} from "../shared/types.js";

export class State {
  private agents = new Map<string, Agent>();
  private locks = new Map<string, Lock>();
  private announcements = new Map<string, Announcement>();
  private issues = new Map<string, Issue>();
  private startedAt = Date.now();
  lastActivity = Date.now();

  private touch() {
    this.lastActivity = Date.now();
  }

  registerAgent(name: string, worktree: string): Agent {
    this.touch();
    const agent: Agent = {
      name,
      worktree,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.agents.set(name, agent);
    return agent;
  }

  deregisterAgent(name: string): void {
    this.touch();
    this.agents.delete(name);
    for (const [resource, lock] of this.locks) {
      if (lock.owner === name) {
        this.locks.delete(resource);
      }
    }
  }

  heartbeat(name: string): boolean {
    this.touch();
    const agent = this.agents.get(name);
    if (!agent) return false;
    agent.lastSeen = Date.now();
    return true;
  }

  getAgents(): Agent[] {
    return [...this.agents.values()];
  }

  acquireLock(
    resource: string,
    owner: string,
    ownerWorktree: string,
    reason: string,
    ttlMs?: number,
  ): { ok: true; lock: Lock } | { ok: false; holder: Lock } {
    this.touch();
    const existing = this.locks.get(resource);
    if (existing) {
      if (existing.expiresAt && existing.expiresAt < Date.now()) {
        this.locks.delete(resource);
      } else {
        return { ok: false, holder: existing };
      }
    }
    const lock: Lock = {
      resource,
      owner,
      ownerWorktree,
      reason,
      acquiredAt: Date.now(),
      expiresAt: ttlMs ? Date.now() + ttlMs : Date.now() + DEFAULT_LOCK_TTL_MS,
    };
    this.locks.set(resource, lock);
    return { ok: true, lock };
  }

  releaseLock(resource: string, owner: string): boolean {
    this.touch();
    const lock = this.locks.get(resource);
    if (!lock || lock.owner !== owner) return false;
    this.locks.delete(resource);
    return true;
  }

  getLocks(): Lock[] {
    return [...this.locks.values()];
  }

  addAnnouncement(
    author: string,
    message: string,
    ttlMs?: number,
  ): Announcement {
    this.touch();
    const announcement: Announcement = {
      id: randomUUID().slice(0, 8),
      author,
      message,
      createdAt: Date.now(),
      expiresAt: ttlMs
        ? Date.now() + ttlMs
        : Date.now() + DEFAULT_ANNOUNCEMENT_TTL_MS,
    };
    this.announcements.set(announcement.id, announcement);
    return announcement;
  }

  getAnnouncements(): Announcement[] {
    return [...this.announcements.values()];
  }

  reportIssue(
    reporter: string,
    title: string,
    description: string,
    severity: "low" | "medium" | "high" | "critical",
  ): Issue {
    this.touch();
    const issue: Issue = {
      id: randomUUID().slice(0, 8),
      reporter,
      title,
      description,
      severity,
      status: "open",
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  resolveIssue(issueId: string, resolvedBy: string): Issue | null {
    this.touch();
    const issue = this.issues.get(issueId);
    if (!issue) return null;
    issue.status = "resolved";
    issue.resolvedAt = Date.now();
    issue.resolvedBy = resolvedBy;
    return issue;
  }

  getIssues(): Issue[] {
    return [...this.issues.values()];
  }

  getStatus(): CoordinationStatus {
    return {
      agents: this.getAgents(),
      locks: this.getLocks(),
      announcements: this.getAnnouncements(),
      issues: this.getIssues().filter((i) => i.status === "open"),
      daemonUptime: Date.now() - this.startedAt,
    };
  }

  cleanup(staleTimeoutMs: number): {
    removedAgents: string[];
    removedLocks: string[];
    removedAnnouncements: string[];
  } {
    const now = Date.now();
    const removedAgents: string[] = [];
    const removedLocks: string[] = [];
    const removedAnnouncements: string[] = [];

    for (const [name, agent] of this.agents) {
      if (now - agent.lastSeen > staleTimeoutMs) {
        this.agents.delete(name);
        removedAgents.push(name);
        for (const [resource, lock] of this.locks) {
          if (lock.owner === name) {
            this.locks.delete(resource);
            removedLocks.push(resource);
          }
        }
      }
    }

    for (const [resource, lock] of this.locks) {
      if (lock.expiresAt && lock.expiresAt < now) {
        this.locks.delete(resource);
        if (!removedLocks.includes(resource)) {
          removedLocks.push(resource);
        }
      }
    }

    for (const [id, ann] of this.announcements) {
      if (ann.expiresAt && ann.expiresAt < now) {
        this.announcements.delete(id);
        removedAnnouncements.push(id);
      }
    }

    return { removedAgents, removedLocks, removedAnnouncements };
  }

  get agentCount(): number {
    return this.agents.size;
  }
}
