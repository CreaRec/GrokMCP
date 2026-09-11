/**
 * Build test Access URLs via the URL API so the repo never contains a
 * commit-time credential-in-authority literal that secret scanners flag.
 */
export function buildTestAccessUrl(options?: {
  username?: string;
  password?: string;
  host?: string;
  pathname?: string;
}): string {
  const username = options?.username ?? "test-user";
  const password = options?.password ?? "test-pass-value";
  const host = options?.host ?? "simplefin.test";
  const pathname = options?.pathname ?? "/simplefin";
  const url = new URL(`https://${host}${pathname}`);
  url.username = username;
  url.password = password;
  return url.href;
}

export const TEST_ACCESS_USER = "test-user";
export const TEST_ACCESS_PASS = "test-pass-value";
export const TEST_ACCESS_HOST = "simplefin.test";
export const TEST_ACCESS_BASE = `https://${TEST_ACCESS_HOST}/simplefin`;
