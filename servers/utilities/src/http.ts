#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getUtilityBills, getWaterDaily } from "./config.js";
import {
  BAD_REQUEST_SESSION_MESSAGE,
  resolveMcpSessionAction,
  SESSION_NOT_FOUND_MESSAGE,
} from "./session.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";
import { WaterDailyArgError } from "./water-daily.js";

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

  server.registerTool(
    "water_daily",
    {
      description:
        "Read daily water usage (gallons) from CreaDashboard. " +
        "Provide start+end (YYYY-MM-DD), or month (YYYY-MM), or omit dates for the current calendar month in America/Chicago. " +
        "Multi-month ranges are fetched month-by-month and merged. Does not scrape WaterSmart.",
      inputSchema: {
        start: z
          .string()
          .optional()
          .describe("Range start date YYYY-MM-DD (requires end). Mutually exclusive with month."),
        end: z
          .string()
          .optional()
          .describe("Range end date YYYY-MM-DD (requires start). Mutually exclusive with month."),
        month: z
          .string()
          .optional()
          .describe("Single month YYYY-MM. Mutually exclusive with start/end."),
      },
    },
    async ({ start, end, month }) => {
      return withToolTelemetry("water_daily", async () => {
        try {
          const data = await getWaterDaily({ start, end, month });
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
          };
        } catch (err) {
          const message =
            err instanceof WaterDailyArgError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
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
        // Ignore stale session ids from clients reconnecting after restart.
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
