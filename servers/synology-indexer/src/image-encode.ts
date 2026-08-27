import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";

/** Longest side after resize for VLM input. */
export const VISION_MAX_DIMENSION = 2048;
/** Do not feed convert a multi-hundred-MB source. */
export const VISION_MAX_INPUT_BYTES = 80 * 1024 * 1024;
/** Cap encoded JPEG so we never build a huge JS string. */
export const VISION_MAX_ENCODED_BYTES = 6 * 1024 * 1024;

export interface ImageEncoder {
  (input: string | Buffer): Promise<string>;
}

function runConvert(args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("convert", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(errChunks).toString("utf8").slice(0, 500);
        reject(new Error(`convert failed (exit ${code}): ${errText}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/**
 * Resize/caps a raster image and return base64 JPEG suitable for Ollama `images[]`.
 * Accepts a filesystem path or an already-decoded image buffer (e.g. PDF page jpeg).
 * Never used for PDF/office/audio bytes.
 */
export async function encodeRasterForVision(
  input: string | Buffer,
  maxDimension: number = VISION_MAX_DIMENSION,
): Promise<string> {
  if (typeof input === "string") {
    const info = await stat(input);
    if (info.size > VISION_MAX_INPUT_BYTES) {
      throw new Error(
        `Image too large for vision encode (${info.size} bytes; max ${VISION_MAX_INPUT_BYTES})`,
      );
    }
  } else if (input.byteLength > VISION_MAX_INPUT_BYTES) {
    throw new Error(
      `Image buffer too large for vision encode (${input.byteLength} bytes; max ${VISION_MAX_INPUT_BYTES})`,
    );
  }

  const resize = `${maxDimension}x${maxDimension}>`;
  let stdout: Buffer;

  if (typeof input === "string") {
    stdout = await runConvert([
      input,
      "-auto-orient",
      "-resize",
      resize,
      "-quality",
      "85",
      "jpeg:-",
    ]);
  } else {
    stdout = await runConvert(
      ["-", "-auto-orient", "-resize", resize, "-quality", "85", "jpeg:-"],
      input,
    );
  }

  if (!stdout.length) {
    throw new Error("Image encode produced empty output");
  }

  if (stdout.byteLength > VISION_MAX_ENCODED_BYTES) {
    throw new Error(
      `Encoded vision image still too large (${stdout.byteLength} bytes after resize)`,
    );
  }

  return stdout.toString("base64");
}
