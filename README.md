# Agent Tower

Coordination tower for multi-agent development workflows. Resource locking, announcements, and issue tracking across concurrent AI coding agents sharing local resources.

## The Problem

When multiple AI coding agents work simultaneously on the same project (e.g., across different git worktrees), they share local resources with no way to communicate:

- One agent resets the database while another is running queries
- Port collisions when multiple agents start dev servers
- Duplicated work across agents with no visibility into what others are doing
- No way to flag shared infrastructure issues

Agent Tower solves this with a lightweight coordination layer.

## Architecture

```
Agent 1 (worktree A) → MCP stdio → HTTP → ┐
Agent 2 (worktree B) → MCP stdio → HTTP → ├─ Daemon (in-memory state)
Agent 3 (worktree C) → MCP stdio → HTTP → ┘
                                           127.0.0.1:7420
```

- **Daemon**: Single Node.js HTTP server holding all state in memory
- **MCP server**: One stdio instance per agent, proxies tool calls to the daemon
- **State is ephemeral** — no persistence, agents re-register on startup

## Quick Start

### Install

```bash
npm install -g agent-tower
# or
pnpm add -g agent-tower
```

### Configure MCP

Add to your `.mcp.json` or Claude Code settings:

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp"
    }
  }
}
```

That's it. The daemon auto-starts on first connection and auto-shuts down after 30 minutes of inactivity. Agent name is auto-detected from the working directory.

### Manual Override

```json
{
  "mcpServers": {
    "agent-tower": {
      "command": "agent-tower-mcp",
      "args": ["--name", "my-agent", "--worktree", "/path/to/worktree"]
    }
  }
}
```

Environment variables: `AGENT_TOWER_NAME`, `AGENT_TOWER_PORT`

## MCP Tools

| Tool | Purpose |
|------|---------|
| `agent_register` | Register with the daemon (auto on startup) |
| `agent_deregister` | Unregister and release all locks |
| `lock_acquire` | Claim exclusive access to a shared resource |
| `lock_release` | Release a lock |
| `lock_list` | View all active locks |
| `announce` | Broadcast a message to all agents |
| `get_announcements` | View active announcements |
| `report_issue` | Report a shared problem |
| `resolve_issue` | Mark an issue as resolved |
| `get_status` | Full overview: agents, locks, announcements, issues |

### Example Workflow

```
Agent 1: lock_acquire("supabase-db", "running migrations")
         → Lock acquired

Agent 2: lock_acquire("supabase-db", "need to seed data")
         → CONFLICT: locked by Agent 1 for "running migrations"

Agent 1: announce("DB migration complete, schema updated")
Agent 1: lock_release("supabase-db")

Agent 2: lock_acquire("supabase-db", "seeding test data")
         → Lock acquired
```

## CLI

```bash
agent-tower start       # Start daemon in background
agent-tower stop        # Stop daemon
agent-tower status      # Show all coordination state
agent-tower daemon      # Run daemon in foreground (debug)
agent-tower logs        # Tail daemon logs
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Port | `7420` | Daemon HTTP port |
| Agent stale timeout | 5 min | Remove agents with no heartbeat |
| Lock TTL | 10 min | Default lock expiration |
| Announcement TTL | 30 min | Default announcement expiration |
| Auto-shutdown | 30 min | Daemon stops after no activity |
| Cleanup interval | 30 sec | Stale resource sweep frequency |

State directory: `~/.agent-tower/` (PID file, port file, daemon log)

## HTTP API

All endpoints on `127.0.0.1:7420`. Agent identity via `x-agent-name` and `x-agent-worktree` headers.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/agents/register` | Register an agent |
| POST | `/agents/deregister` | Unregister an agent |
| POST | `/agents/heartbeat` | Update last-seen timestamp |
| GET | `/agents` | List all agents |
| POST | `/locks/acquire` | Acquire a lock (409 on conflict) |
| POST | `/locks/release` | Release a lock |
| GET | `/locks` | List all locks |
| POST | `/announcements` | Create an announcement |
| GET | `/announcements` | List active announcements |
| POST | `/issues` | Report an issue |
| POST | `/issues/resolve` | Resolve an issue |
| GET | `/issues` | List all issues |
| GET | `/status` | Full coordination state |
| GET | `/health` | Health check |
| POST | `/shutdown` | Graceful shutdown |

## Development

```bash
git clone https://github.com/dbendaou/mcp-agent-tower.git
cd mcp-agent-tower
pnpm install
pnpm build
```

## License

MIT
