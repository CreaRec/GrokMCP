import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const openAsBlobMock = vi.fn();

vi.mock("node:fs", () => ({
  openAsBlob: (...args: unknown[]) => openAsBlobMock(...args),
}));

import { convertFileToMarkdown } from "./docling-client.js";

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

  it("POSTs file to docling-serve and returns md_content", async () => {
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
    expect(openAsBlobMock).toHaveBeenCalledWith("/mnt/synology/Documents/report.pdf");
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
