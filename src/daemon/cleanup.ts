import { CLEANUP_INTERVAL_MS, AGENT_STALE_TIMEOUT_MS } from "../shared/config.js";
import type { State } from "./state.js";

export function startCleanupInterval(
  state: State,
  log: (msg: string) => void,
): NodeJS.Timeout {
  return setInterval(() => {
    const result = state.cleanup(AGENT_STALE_TIMEOUT_MS);
    if (
      result.removedAgents.length ||
      result.removedLocks.length ||
      result.removedAnnouncements.length
    ) {
      log(
        `[cleanup] removed agents=${result.removedAgents.join(",") || "none"} ` +
          `locks=${result.removedLocks.join(",") || "none"} ` +
          `announcements=${result.removedAnnouncements.join(",") || "none"}`,
      );
    }
  }, CLEANUP_INTERVAL_MS);
}
