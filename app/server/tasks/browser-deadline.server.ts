/**
 * The browser mount's name and its clocks, in a module with no imports, so the
 * mount, the supervisor's command line and the Codex adapter read one source.
 */

/** Reserved server name (joins viberr/viberr_agent in RESERVED_MCP_NAMES). */
export const BROWSER_MCP_NAME = "viberr_browser";

/**
 * Ruling 554: how long a browser call may run before the supervisor restarts
 * the browser. Longer than any answer the server gives while its page still
 * answers: a navigation times out at 60 s, then waits up to 10 s for the load
 * and reads the page for its answer, and a wait is capped at 30 s.
 */
export const BROWSER_CALL_DEADLINE_MS = 90_000;

/**
 * Ruling 554: how long Codex waits on a browser call (`tool_timeout_sec`).
 * Longer than the deadline, so the supervisor's answer, which says the browser
 * was restarted, is the one the model reads: Codex's own default gives up
 * first, and its "timed out" says nothing of the restart that follows.
 */
export const BROWSER_TOOL_TIMEOUT_SEC = 120;
