# Changelog

## 0.2.0 — 2026-09-22

### Added

- Directed and skill-routed inter-agent asks, per-session inboxes, correlated replies, and requester-only result polling.
- UUID session identities and private credentials, including distinct ownership for agents with the same display name.
- Bounded ask lifetimes, waiting, retention, and audit metadata, with first-reply-wins handling for skill fan-out.

### Fixed

- Explicit deregistration remains inactive until the next registration or check-in, even during overlapping heartbeat recovery.
- Recovered sessions restore their last successfully advertised skills and retry transient restoration failures.
- Ask waits wake at TTL expiry even when the requested wait is longer; aborted waits leave the ask available for a later reply.
- `pnpm test` builds the current sources before running the 15-test regression suite.

### Upgrade notes

The daemon protocol is incompatible with 0.1.0. Disconnect all MCP clients, stop the old daemon, install and build v0.2.0, then reconnect all clients. Restarting discards in-memory coordination state. Follow the [step-by-step upgrade instructions](README.md#upgrade-from-010-to-020).

This release uses the existing source-install workflow. Messaging is local and requires agents to poll their inboxes; persistence, SSE, and A2A endpoints are not included.
