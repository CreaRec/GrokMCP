import { afterEach, describe, expect, it } from "vitest";
import { getConfig } from "./config.js";

const KEYS = ["TG_SEARCH_API_TOKEN", "TG_SEARCH_API_URL", "TG_SEARCH_API_TIMEOUT_MS"] as const;

describe("getConfig", () => {
  const prev: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });

  function isolate() {
    for (const key of KEYS) {
      prev[key] = process.env[key];
      delete process.env[key];
    }
  }

  it("requires TG_SEARCH_API_TOKEN", () => {
    isolate();
    expect(() => getConfig({})).toThrow(/TG_SEARCH_API_TOKEN/);
  });

  it("defaults the API URL and timeout", () => {
    isolate();
    const cfg = getConfig({ TG_SEARCH_API_TOKEN: "secret-token-value" });
    expect(cfg.apiUrl).toBe("http://100.118.169.52:8787");
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.token).toBe("secret-token-value");
  });

  it("strips a trailing slash and validates timeout", () => {
    isolate();
    const cfg = getConfig({
      TG_SEARCH_API_TOKEN: "secret-token-value",
      TG_SEARCH_API_URL: "http://example:8787/",
      TG_SEARCH_API_TIMEOUT_MS: "5000",
    });
    expect(cfg.apiUrl).toBe("http://example:8787");
    expect(cfg.timeoutMs).toBe(5000);
    expect(() =>
      getConfig({ TG_SEARCH_API_TOKEN: "secret-token-value", TG_SEARCH_API_TIMEOUT_MS: "0" }),
    ).toThrow(/TG_SEARCH_API_TIMEOUT_MS/);
  });
});
