import { describe, expect, it } from "vitest";
import {
  AccessUrlError,
  parseAccessUrl,
  redactSecrets,
} from "./access-url.js";
import {
  TEST_ACCESS_BASE,
  TEST_ACCESS_HOST,
  TEST_ACCESS_PASS,
  TEST_ACCESS_USER,
  buildTestAccessUrl,
} from "./test-access-url.js";

const SAMPLE_ACCESS_URL = buildTestAccessUrl();

describe("parseAccessUrl", () => {
  it("extracts base URL and Basic Auth without embedding credentials in baseUrl", () => {
    const parsed = parseAccessUrl(SAMPLE_ACCESS_URL);
    expect(parsed.baseUrl).toBe(TEST_ACCESS_BASE);
    expect(parsed.username).toBe(TEST_ACCESS_USER);
    expect(parsed.password).toBe(TEST_ACCESS_PASS);
    expect(parsed.host).toBe(TEST_ACCESS_HOST);
    expect(parsed.authorizationHeader).toMatch(/^Basic /);
    expect(parsed.baseUrl).not.toContain(TEST_ACCESS_USER);
    expect(parsed.baseUrl).not.toContain(TEST_ACCESS_PASS);
  });

  it("rejects missing credentials and non-https", () => {
    expect(() => parseAccessUrl(TEST_ACCESS_BASE)).toThrow(AccessUrlError);
    const httpUrl = new URL(TEST_ACCESS_BASE);
    httpUrl.protocol = "http:";
    httpUrl.username = TEST_ACCESS_USER;
    httpUrl.password = "x";
    expect(() => parseAccessUrl(httpUrl.href)).toThrow(/https/);
  });
});

describe("redactSecrets", () => {
  it("redacts the Access URL and password from free-form text", () => {
    const message = `Failed contacting ${SAMPLE_ACCESS_URL} password=${TEST_ACCESS_PASS}`;
    const redacted = redactSecrets(message, {
      accessUrl: SAMPLE_ACCESS_URL,
      username: TEST_ACCESS_USER,
      password: TEST_ACCESS_PASS,
    });
    expect(redacted).not.toContain(TEST_ACCESS_PASS);
    expect(redacted).not.toContain(SAMPLE_ACCESS_URL);
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts generic embedded-auth URL patterns without explicit secrets", () => {
    const leak = buildTestAccessUrl({
      username: "alice",
      password: "not-a-real-secret",
      host: "bridge.example.test",
    });
    const redacted = redactSecrets(`curl ${leak}/accounts`);
    expect(redacted).not.toContain("not-a-real-secret");
    expect(redacted).toContain("[REDACTED]");
  });
});
