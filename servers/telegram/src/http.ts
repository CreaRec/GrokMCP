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
import { telegramSearch } from "./search.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";

const searchInput = {
  query: z.string().min(1).describe("Search query over the owner's Telegram archive"),
  chat_ids: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe("Optional chat id filter"),
  from: z.string().optional().describe("Inclusive start date (YYYY-MM-DD or ISO)"),
  to: z.string().optional().describe("Inclusive end date (YYYY-MM-DD or ISO)"),
  limit: z.number().int().min(1).max(50).optional().describe("Max hits (1-50, default 10)"),
};

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function createServer() {
  const server = new McpServer(
    { name: "telegram", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "telegram_search",
    {
      description:
        "Search the owner's Telegram archive (local tg-search index). " +
        "Returns matching fragments with chat title, type, dates, senders, a snippet, " +
        "and Telegram links (message deep link, chat link, or date only). " +
        "No LLM / ask: this is search-only and does not send the archive off the server.",
      inputSchema: searchInput,
    },
    async (args) => {
      return withToolTelemetry("telegram_search", async () => {
        try {
          const data = await telegramSearch(args);
          return jsonResult({ ok: true, data });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ ok: false, error: message });
        }
      });
    },
  );

  return server;
}

async function main() {
  startTelemetry();

  const PORT = parseInt(process.env.PORT ?? "8798", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  const app = createMcpExpressApp({ host: HOST });
  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "telegram-mcp", version: "0.1.0" });
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
    console.error(`Telegram MCP server listening on http://${HOST}:${PORT}`);
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
