import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { embedQuery, formatVectorForPg } from "./embedder.js";

export interface SearchResult {
  label: string;
  shareUrl: string;
  kind: "file" | "folder";
  score?: number;
}

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    const adapter = new PrismaPg({ connectionString });
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export async function searchSynology(
  query: string,
  limit: number = 8,
): Promise<SearchResult[]> {
  const embedding = await embedQuery(query);
  const vectorStr = formatVectorForPg(embedding);
  const db = getPrisma();

  const fileResults = await db.$queryRaw<
    Array<{ label: string; share_url: string; kind: string; distance: number }>
  >`
    SELECT
      label,
      share_url,
      kind,
      embedding <=> ${vectorStr}::vector AS distance
    FROM files
    WHERE embedding IS NOT NULL
      AND share_url IS NOT NULL
      AND deleted_at IS NULL
    ORDER BY distance ASC
    LIMIT ${limit}
  `;

  const folderResults = await db.$queryRaw<
    Array<{ label: string; share_url: string; distance: number }>
  >`
    SELECT
      label,
      share_url,
      embedding <=> ${vectorStr}::vector AS distance
    FROM folders
    WHERE embedding IS NOT NULL
      AND share_url IS NOT NULL
      AND deleted_at IS NULL
    ORDER BY distance ASC
    LIMIT ${limit}
  `;

  const combined: Array<{
    label: string;
    shareUrl: string;
    kind: "file" | "folder";
    distance: number;
  }> = [];

  for (const row of fileResults) {
    combined.push({
      label: row.label,
      shareUrl: row.share_url,
      kind: row.kind === "folder" ? "folder" : "file",
      distance: row.distance,
    });
  }

  for (const row of folderResults) {
    combined.push({
      label: row.label,
      shareUrl: row.share_url,
      kind: "folder",
      distance: row.distance,
    });
  }

  combined.sort((a, b) => a.distance - b.distance);
  const topK = combined.slice(0, limit);

  return topK.map((item) => ({
    label: item.label,
    shareUrl: item.shareUrl,
    kind: item.kind,
    score: item.distance > 0 ? Math.round((1 - item.distance) * 1000) / 1000 : 1,
  }));
}
