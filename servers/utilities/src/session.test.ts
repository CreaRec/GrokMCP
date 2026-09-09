import { describe, expect, it } from "vitest";
import {
  BAD_REQUEST_SESSION_MESSAGE,
  resolveMcpSessionAction,
  SESSION_NOT_FOUND_MESSAGE,
} from "./session.js";

describe("resolveMcpSessionAction", () => {
  it("reuses a known session", () => {
    expect(
      resolveMcpSessionAction({
        sessionId: "known",
        hasTransport: true,
        isInitialize: false,
      }),
    ).toEqual({ type: "reuse" });
  });

  it("creates a new session on initialize without a session header", () => {
    expect(
      resolveMcpSessionAction({
        sessionId: undefined,
        hasTransport: false,
        isInitialize: true,
      }),
    ).toEqual({ type: "initialize" });
  });

  it("creates a new session on initialize even with a stale session header", () => {
    expect(
      resolveMcpSessionAction({
        sessionId: "stale",
        hasTransport: false,
        isInitialize: true,
      }),
    ).toEqual({ type: "initialize" });
  });

  it("reports session not found for non-initialize with unknown session id", () => {
    expect(
      resolveMcpSessionAction({
        sessionId: "stale",
        hasTransport: false,
        isInitialize: false,
      }),
    ).toEqual({ type: "session_not_found" });
  });

  it("rejects non-initialize requests with no session id", () => {
    expect(
      resolveMcpSessionAction({
        sessionId: undefined,
        hasTransport: false,
        isInitialize: false,
      }),
    ).toEqual({ type: "bad_request" });
  });

  it("prefers reuse over initialize when the session is known", () => {
    expect(
      resolveMcpSessionAction({
        sessionId: "known",
        hasTransport: true,
        isInitialize: true,
      }),
    ).toEqual({ type: "reuse" });
  });

  it("exposes clear client-facing error messages", () => {
    expect(SESSION_NOT_FOUND_MESSAGE).toBe("Session not found; reinitialize");
    expect(BAD_REQUEST_SESSION_MESSAGE).toBe(
      "Bad Request: No valid session ID provided",
    );
  });
});
