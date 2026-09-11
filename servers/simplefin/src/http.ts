#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getTransactions, listAccounts } from "./config.js";
import { DateRangeError } from "./dates.js";
import { AccessUrlError } from "./access-url.js";
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

const accountArgSchema = z.union([z.string(), z.array(z.string())]).optional();

function toolErrorMessage(err: unknown): string {
  if (
    err instanceof DateRangeError ||
    err instanceof AccessUrlError ||
    err instanceof Error
  ) {
    return err.message;
  }
  return String(err);
}

function createServer() {
  const server = new McpServer(
    { name: "simplefin", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_accounts",
    {
      description:
        "List SimpleFIN Bridge accounts with balances (version=2, balances-only). " +
        "Returns id, name, currency, balance, available-balance, balance-date (ISO), and org name/domain. " +
        "Includes top-level SimpleFIN errors/errlist when present. Does not scrape banks. " +
        "Note: Bridge expects roughly ≤24 API requests/day — prefer caching over polling.",
      inputSchema: {},
    },
    async () => {
      return withToolTelemetry("list_accounts", async () => {
        try {
          const data = await listAccounts();
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: toolErrorMessage(err) }),
              },
            ],
          };
        }
      });
    },
  );

  server.registerTool(
    "get_transactions",
    {
      description:
        "Fetch SimpleFIN Bridge transactions for a date range (max 90 days). " +
        "start/end are YYYY-MM-DD interpreted in America/Chicago; mapped to Unix start-date (inclusive) " +
        "and end-date (exclusive). Optional account id(s) and pending=true. " +
        "Returns flattened transactions with id, posted (ISO or null), amount, description, payee, memo, account id/name.",
      inputSchema: {
        start: z
          .string()
          .describe("Range start date YYYY-MM-DD (America/Chicago midnight, inclusive)."),
        end: z
          .string()
          .describe(
            "Range end date YYYY-MM-DD (America/Chicago midnight, exclusive per SimpleFIN). Max 90 days after start.",
          ),
        account: accountArgSchema.describe(
          "Optional account id, or array of ids (repeatable SimpleFIN account= filter).",
        ),
        pending: z
          .boolean()
          .optional()
          .describe("If true, include pending transactions (pending=1)."),
      },
    },
    async ({ start, end, account, pending }) => {
      return withToolTelemetry("get_transactions", async () => {
        try {
          const data = await getTransactions({ start, end, account, pending });
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: toolErrorMessage(err) }),
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

  const PORT = parseInt(process.env.PORT ?? "8798", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  const app = createMcpExpressApp({ host: HOST });
  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "simplefin-mcp", version: "0.1.0" });
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
    console.error(`SimpleFIN MCP server listening on http://${HOST}:${PORT}`);
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
