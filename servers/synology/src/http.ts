#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";
import { searchSynology, disconnectPrisma } from "./search.js";
import { getEmbedder, EMBEDDING_DIM, MODEL_ID } from "./embedder.js";

function getConfig() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing required env var: DATABASE_URL");
  }
  return { databaseUrl };
}

function createServer() {
  const server = new McpServer(
    { name: "synology", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "synology_search",
    {
      description:
        "Search Synology NAS files and folders by semantic similarity. " +
        "Returns matching items with their share URLs. " +
        "PRIVACY: Results include only label, shareUrl, kind (file/folder), and relevance score. " +
        "File paths, descriptions, and internal IDs are never returned.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Natural language search query describing what you're looking for"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of results to return. Default: 8"),
      },
    },
    async ({ query, limit }) => {
      return withToolTelemetry("synology_search", async () => {
        try {
          const maxResults = limit ?? 8;
          const results = await searchSynology(query, maxResults);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  data: {
                    results,
                    count: results.length,
                  },
                }),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: message }),
              },
            ],
          };
        }
      });
    },
  );

  return server;
}

async function main() {
  startTelemetry();

  getConfig();

  console.error(`[synology-mcp] Pre-loading embedding model...`);
  await getEmbedder();
  console.error(`[synology-mcp] Model ready: ${MODEL_ID} (${EMBEDDING_DIM}d)`);

  const PORT = parseInt(process.env.PORT ?? "8794", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  const app = createMcpExpressApp({ host: HOST });

  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "synology-mcp",
      version: "0.1.0",
      model: MODEL_ID,
      embeddingDim: EMBEDDING_DIM,
    });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  });

  app.listen(PORT, HOST, () => {
    console.error(`Synology MCP server listening on http://${HOST}:${PORT}`);
    console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
    console.error(`Health check: http://${HOST}:${PORT}/health`);
  });

  process.on("SIGINT", async () => {
    console.error("Shutting down...");
    await disconnectPrisma();
    await shutdownTelemetry();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("Shutting down...");
    await disconnectPrisma();
    await shutdownTelemetry();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
