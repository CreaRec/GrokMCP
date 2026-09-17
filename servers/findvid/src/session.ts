/**
 * Pure session-routing decision for Streamable HTTP POST /mcp.
 * Allows initialize even when a stale mcp-session-id header is present
 * (e.g. after server restart while mcp-remote still holds the old id).
 */
export type McpSessionAction =
  | { type: "reuse" }
  | { type: "initialize" }
  | { type: "session_not_found" }
  | { type: "bad_request" };

export function resolveMcpSessionAction(options: {
  sessionId: string | undefined;
  hasTransport: boolean;
  isInitialize: boolean;
}): McpSessionAction {
  const { sessionId, hasTransport, isInitialize } = options;

  if (sessionId && hasTransport) {
    return { type: "reuse" };
  }
  if (isInitialize) {
    return { type: "initialize" };
  }
  if (sessionId) {
    return { type: "session_not_found" };
  }
  return { type: "bad_request" };
}

export const SESSION_NOT_FOUND_MESSAGE =
  "Session not found; reinitialize";

export const BAD_REQUEST_SESSION_MESSAGE =
  "Bad Request: No valid session ID provided";
