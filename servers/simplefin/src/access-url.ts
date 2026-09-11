/**
 * Parse and redact SimpleFIN Access URLs.
 * Access URLs embed HTTP Basic Auth in the authority — never log the raw value.
 */

export interface ParsedAccessUrl {
  /** Origin + pathname without credentials (no trailing slash). */
  baseUrl: string;
  username: string;
  password: string;
  /** Value for the Authorization header (including "Basic "). */
  authorizationHeader: string;
  /** Hostname only, safe for error messages. */
  host: string;
}

export class AccessUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessUrlError";
  }
}

function basicAuthHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

/**
 * Parse a SimpleFIN Access URL into a credential-free base URL + Basic Auth parts.
 */
export function parseAccessUrl(raw: string): ParsedAccessUrl {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AccessUrlError("SIMPLEFIN_ACCESS_URL is empty");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AccessUrlError(
      "SIMPLEFIN_ACCESS_URL is not a valid URL (expected https Access URL with embedded Basic Auth)",
    );
  }

  if (url.protocol !== "https:") {
    throw new AccessUrlError("SIMPLEFIN_ACCESS_URL must use https");
  }

  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!username || !password) {
    throw new AccessUrlError(
      "SIMPLEFIN_ACCESS_URL must include embedded Basic Auth credentials",
    );
  }

  const clean = new URL(url.toString());
  clean.username = "";
  clean.password = "";
  // Drop hash/search; Access URL is the API root.
  clean.hash = "";
  clean.search = "";
  let baseUrl = clean.toString();
  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  return {
    baseUrl,
    username,
    password,
    authorizationHeader: basicAuthHeader(username, password),
    host: url.host,
  };
}

/**
 * Redact Access URL credentials (and common variants) from a string for logs/errors.
 */
export function redactSecrets(
  text: string,
  secrets: { accessUrl?: string; username?: string; password?: string } = {},
): string {
  let out = text;

  const candidates: string[] = [];
  if (secrets.accessUrl) {
    candidates.push(secrets.accessUrl);
    try {
      const parsed = new URL(secrets.accessUrl);
      if (parsed.username || parsed.password) {
        candidates.push(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
        );
        candidates.push(decodeURIComponent(parsed.password));
        candidates.push(decodeURIComponent(parsed.username));
      }
    } catch {
      // ignore
    }
  }
  if (secrets.username && secrets.password) {
    candidates.push(`${secrets.username}:${secrets.password}`);
  }
  if (secrets.password) {
    candidates.push(secrets.password);
  }
  if (secrets.username) {
    candidates.push(secrets.username);
  }

  // Generic embedded-auth authority patterns (including URL-encoded forms).
  out = out.replace(
    /https?:\/\/[^/\s"'<>]+@[^\s"'<>]+/gi,
    "https://[REDACTED]@host",
  );
  out = out.replace(
    /\b[A-Za-z0-9._~+-]+:[^@\s/'"]+@/g,
    "[REDACTED]:[REDACTED]@",
  );

  for (const secret of candidates) {
    if (!secret || secret.length < 2) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "[REDACTED]");
  }

  return out;
}
