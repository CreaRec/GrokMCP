import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const openAsBlobMock = vi.fn();

vi.mock("node:fs", () => ({
  openAsBlob: (...args: unknown[]) => openAsBlobMock(...args),
}));

import {
  convertFileToMarkdown,
  doclingGistPageRange,
  DEFAULT_DOCLING_GIST_PAGE_END,
} from "./docling-client.js";

describe("doclingGistPageRange", () => {
  it("always returns pages 1 through end (default 5)", () => {
    expect(doclingGistPageRange()).toEqual([1, DEFAULT_DOCLING_GIST_PAGE_END]);
    expect(doclingGistPageRange(5)).toEqual([1, 5]);
  });
});

describe("convertFileToMarkdown", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    openAsBlobMock.mockReset();
    openAsBlobMock.mockResolvedValue(new Blob(["pdf-bytes"]));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs file to docling-serve with default page_range 1-5", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        document: { md_content: "# Title\n\nBody text." },
        status: "success",
      }),
    });

    const md = await convertFileToMarkdown(
      "/mnt/synology/Documents/report.pdf",
      "http://docling-serve:5001",
    );

    expect(md).toBe("# Title\n\nBody text.");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://docling-serve:5001/v1/convert/file");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    expect(form.getAll("page_range")).toEqual(["1", "5"]);
    expect(openAsBlobMock).toHaveBeenCalledWith("/mnt/synology/Documents/report.pdf");
  });

  it("sends page_range 1-5 for office and html formats too", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        document: { md_content: "# Sheet head" },
      }),
    });

    for (const path of [
      "/mnt/synology/Documents/report.docx",
      "/mnt/synology/data/sheet.xlsx",
      "/mnt/synology/site/page.html",
    ]) {
      fetchMock.mockClear();
      await convertFileToMarkdown(path, "http://docling:5001", {
        convertTimeoutMs: 90_000,
        documentTimeoutSec: 90,
      });

      const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
      expect(form.getAll("page_range")).toEqual(["1", "5"]);
      expect(form.get("document_timeout")).toBe("90");
    }
  });

  it("sends page_range as two separate form fields when overridden", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        document: { md_content: "# Page 1" },
      }),
    });

    await convertFileToMarkdown("/mnt/synology/Documents/closing.pdf", "http://docling:5001", {
      pageRange: [1, 5],
      convertTimeoutMs: 90_000,
      documentTimeoutSec: 90,
    });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.getAll("page_range")).toEqual(["1", "5"]);

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.signal).toBeDefined();
  });

  it("throws on client-side convert timeout", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("Timeout"), { name: "TimeoutError" }));

    await expect(
      convertFileToMarkdown("/mnt/synology/Documents/huge.docx", "http://docling:5001", {
        convertTimeoutMs: 1000,
        documentTimeoutSec: 90,
      }),
    ).rejects.toThrow("timed out after 1000ms");
  });

  it("throws when docling returns empty markdown", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ document: { md_content: "" } }),
    });

    await expect(
      convertFileToMarkdown("/mnt/synology/Documents/empty.pdf", "http://docling:5001"),
    ).rejects.toThrow("no markdown content");
  });
});
