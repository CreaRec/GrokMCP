#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getUtilityBills } from "./config.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";

function createServer() {
  const server = new McpServer(
    { name: "utilities", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "utility_bills",
    {
      description:
        "Read monthly electricity, water, and gas bills from CreaDashboard. " +
        "Returns the latest billed month vs the previous billed month (cost and consumption deltas). " +
        "If the newest month has no bill yet, it is flagged as unbilled instead of treating $0 as a real bill.",
      inputSchema: {
        months: z
          .number()
          .int()
          .min(2)
          .max(6)
          .optional()
          .describe(
            "Number of billed months to include in history (2-6). Comparison always uses the two most recent billed months.",
          ),
      },
    },
    async ({ months }) => {
      return withToolTelemetry("utility_bills", async () => {
        try {
          const data = await getUtilityBills(months ?? 2);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
          };
        }
      });
    },
  );

  return server;
}

async function main() {
  startTelemetry();

  const PORT = parseInt(process.env.PORT ?? "8795", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  const app = createMcpExpressApp({ host: HOST });
  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "utilities-mcp", version: "0.1.0" });
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
    console.error(`Utilities MCP server listening on http://${HOST}:${PORT}`);
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
