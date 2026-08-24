import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });

    stream.on("end", () => {
      resolve(hash.digest("hex").toLowerCase());
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}
