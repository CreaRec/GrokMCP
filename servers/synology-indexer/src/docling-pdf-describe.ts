import { basename } from "node:path";
import type { Config } from "./config.js";
import {
  convertFileToMarkdown,
  doclingGistPageRange,
  doclingHeavyFailureReason,
  isDoclingHeavyFailure,
} from "./docling-client.js";
import { isPdfPath } from "./pdf-slice.js";
import {
  cleanupPdfPageJpegTemp,
  rasterizePdfFirstPageToJpeg,
} from "./pdf-page-jpeg.js";
import { logInfo } from "./telemetry.js";
import {
  describeFromDocumentText,
  describeWithVisionImage,
  type DescribeDocumentOptions,
} from "./vision.js";

export interface DoclingPdfDescribeResult {
  label: string;
  description: string;
  redacted: boolean;
}

function doclingConvertOptions(config: Config, pageRangeEnd: number) {
  return {
    pageRange: doclingGistPageRange(pageRangeEnd) as [number, number],
    convertTimeoutMs: config.doclingConvertTimeoutMs,
    documentTimeoutSec: config.doclingDocumentTimeoutSec,
  };
}

async function convertPdfGist(
  absolutePath: string,
  config: Config,
  pageRangeEnd: number,
): Promise<string> {
  if (!config.doclingServeUrl) {
    throw new Error("Docling is not configured (DOCLING_SERVE_URL)");
  }
  return convertFileToMarkdown(absolutePath, config.doclingServeUrl, doclingConvertOptions(config, pageRangeEnd));
}

/**
 * PDF-only Docling describe chain:
 * 1) default gist (pages 1..N, usually 5)
 * 2) on heavy failure, 1-page gist retry
 * 3) on heavy failure again, rasterize page 1 and describe via qwen-image
 */
export async function describeDoclingPdfWithFallback(
  absolutePath: string,
  fileName: string,
  config: Config,
  ollamaUrl: string,
  describeOpts: DescribeDocumentOptions,
): Promise<DoclingPdfDescribeResult> {
  if (!isPdfPath(absolutePath)) {
    throw new Error("describeDoclingPdfWithFallback is PDF-only");
  }

  const defaultPages = config.doclingPageRangeEnd;

  logInfo("docling gist attempt", {
    source: basename(absolutePath),
    from_pages: 1,
    to_pages: defaultPages,
  });

  try {
    const markdown = await convertPdfGist(absolutePath, config, defaultPages);
    return describeFromDocumentText(
      markdown,
      fileName,
      ollamaUrl,
      config.visionModel,
      describeOpts,
    );
  } catch (err) {
    if (!isDoclingHeavyFailure(err)) {
      throw err;
    }

    const reason = doclingHeavyFailureReason(err);
    logInfo("docling gist fallback", {
      from_pages: defaultPages,
      to_pages: 1,
      reason,
    });

    logInfo("docling gist attempt", {
      source: basename(absolutePath),
      from_pages: 1,
      to_pages: 1,
    });

    try {
      const markdown = await convertPdfGist(absolutePath, config, 1);
      return describeFromDocumentText(
        markdown,
        fileName,
        ollamaUrl,
        config.visionModel,
        describeOpts,
      );
    } catch (retryErr) {
      if (!isDoclingHeavyFailure(retryErr)) {
        throw retryErr;
      }

      const retryReason = doclingHeavyFailureReason(retryErr);
      const converted = await rasterizePdfFirstPageToJpeg(absolutePath);
      logInfo("docling gist fallback", {
        from_pages: 1,
        to_pages: "qwen-image",
        reason: retryReason,
        jpeg_dest: converted.jpegPath,
        jpeg_bytes: converted.jpegBytes,
      });

      try {
        return await describeWithVisionImage(converted.jpegPath, ollamaUrl, config.visionModel);
      } finally {
        await cleanupPdfPageJpegTemp(converted.tempDir);
      }
    }
  }
}
