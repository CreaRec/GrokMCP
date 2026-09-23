#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  BAD_REQUEST_SESSION_MESSAGE,
  resolveMcpSessionAction,
  SESSION_NOT_FOUND_MESSAGE,
} from "./session.js";
import { getFindvidService } from "./service-factory.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";

function toolErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }],
  };
}

function fail(err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: toolErrorMessage(err) }),
      },
    ],
  };
}

function createServer() {
  const server = new McpServer(
    { name: "findvid", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "search",
    {
      description:
        "Search Findvid (Telegram inline bot) for a movie/show. Returns the single best match " +
        "(title, year, kp/imdb meta, thumb URL when available) plus a short alternatives list. " +
        "Persists query/result ids for follow-up tools. " +
        "Preferred agent flow: search → show best match → list_voiceovers → user picks voiceover " +
        "only → list_qualities → agent picks max quality → confirm_and_forward immediately " +
        "(no second user OK). After voiceover, qualities arrive on a new message — not the film. " +
        "Озвучка/Качество are chrome menu openers, not picks. " +
        "VIP/rate-limits/UI changes on Findvid can break automation.",
      inputSchema: {
        query: z.string().describe("Movie or series search query (e.g. Russian or English title)."),
      },
    },
    async ({ query }) => {
      return withToolTelemetry("search", async () => {
        try {
          const service = await getFindvidService();
          const data = await service.search(query);
          return ok(data);
        } catch (err) {
          return fail(err);
        }
      });
    },
  );

  server.registerTool(
    "list_voiceovers",
    {
      description:
        "After search: send/select the best (or given) inline result, open the Озвучка chrome " +
        "submenu when the movie card still shows the top-level menu, and return real озвучки " +
        "labels (Back Board Cinema, Дублированный, …). Chrome/nav buttons are excluded.",
      inputSchema: {
        resultId: z
          .string()
          .optional()
          .describe("Inline result id to select (defaults to best match from search)."),
      },
    },
    async ({ resultId }) => {
      return withToolTelemetry("list_voiceovers", async () => {
        try {
          const service = await getFindvidService();
          const data = await service.listVoiceovers({ resultId });
          return ok(data);
        } catch (err) {
          return fail(err);
        }
      });
    },
  );

  server.registerTool(
    "list_qualities",
    {
      description:
        "Select voiceover (studio). Wait for a NEW message with quality buttons (1080p/720p/…). " +
        "Does not treat post-voiceover preview/media as the film. Returns real Nx p options. " +
        "Agent should pick max quality and call confirm_and_forward without asking again.",
      inputSchema: {
        voiceover: z
          .string()
          .optional()
          .describe("Voiceover button label to select (substring match ok)."),
      },
    },
    async ({ voiceover }) => {
      return withToolTelemetry("list_qualities", async () => {
        try {
          const service = await getFindvidService();
          const data = await service.listQualities({ voiceover });
          return ok(data);
        } catch (err) {
          return fail(err);
        }
      });
    },
  );

  server.registerTool(
    "confirm_and_forward",
    {
      description:
        "After voiceover + quality: click quality (film arrives on a NEW message after that click, " +
        "not after voiceover alone), forward to CreaVideoDownloaderBot. Rejects tiny guides and " +
        "post-voiceover previews. Does NOT download. Preferred: user confirmed voiceover only — " +
        "pick max quality and call this immediately.",
      inputSchema: {
        resultId: z
          .string()
          .optional()
          .describe("Override inline result id (defaults to best match)."),
        voiceover: z
          .string()
          .optional()
          .describe("Override voiceover label (default prefers Дублированный)."),
        quality: z
          .string()
          .optional()
          .describe("Override quality label (default prefers 1080p then 720p)."),
      },
    },
    async ({ resultId, voiceover, quality }) => {
      return withToolTelemetry("confirm_and_forward", async () => {
        try {
          const service = await getFindvidService();
          const data = await service.confirmAndForward({ resultId, voiceover, quality });
          return ok(data);
        } catch (err) {
          return fail(err);
        }
      });
    },
  );

  return server;
}

async function main() {
  startTelemetry();

  const PORT = parseInt(process.env.PORT ?? "8800", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  const app = createMcpExpressApp({ host: HOST });
  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "findvid-mcp", version: "0.1.0" });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const action = resolveMcpSessionAction({
        sessionId,
        hasTransport: Boolean(sessionId && transports.has(sessionId)),
        isInitialize: isInitializeRequest(req.body),
      });

      if (action.type === "reuse") {
        await transports.get(sessionId!)!.handleRequest(req, res, req.body);
        return;
      }

      if (action.type === "initialize") {
        if (sessionId) {
          delete req.headers["mcp-session-id"];
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (action.type === "session_not_found") {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: SESSION_NOT_FOUND_MESSAGE },
          id: null,
        });
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: BAD_REQUEST_SESSION_MESSAGE },
        id: null,
      });
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
    console.error(`Findvid MCP server listening on http://${HOST}:${PORT}`);
    console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
    console.error(`Health check: http://${HOST}:${PORT}/health`);
  });

  process.on("SIGINT", async () => {
    console.error("Shutting down...");
    await shutdownTelemetry();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("Shutting down...");
    await shutdownTelemetry();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
