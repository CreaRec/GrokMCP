import { describe, it, expect } from "vitest";
import {
  isDoclingHeavyFailure,
  doclingHeavyFailureReason,
  DOCLING_HEAVY_HTTP_STATUSES,
} from "./docling-client.js";

describe("isDoclingHeavyFailure", () => {
  it("detects client-side convert timeout", () => {
    const err = new Error("Docling conversion timed out after 90000ms");
    expect(isDoclingHeavyFailure(err)).toBe(true);
    expect(doclingHeavyFailureReason(err)).toBe("client_timeout");
  });

  it("detects HTTP 504 and 524", () => {
    for (const status of DOCLING_HEAVY_HTTP_STATUSES) {
      const err = new Error(`Docling conversion failed: HTTP ${status}`);
      expect(isDoclingHeavyFailure(err)).toBe(true);
      expect(doclingHeavyFailureReason(err)).toBe(`http_${status}`);
    }
  });

  it("does not treat empty markdown or other HTTP errors as heavy", () => {
    expect(isDoclingHeavyFailure(new Error("Docling conversion returned no markdown content"))).toBe(
      false,
    );
    expect(isDoclingHeavyFailure(new Error("Docling conversion failed: HTTP 400"))).toBe(false);
    expect(isDoclingHeavyFailure(new Error("Docling conversion failed: HTTP 503"))).toBe(false);
    expect(isDoclingHeavyFailure("not an error")).toBe(false);
  });
});
