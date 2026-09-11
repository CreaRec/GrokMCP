#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { listPrinters, printFile, type DuplexMode } from "./cups.js";
import { cleanupResolvedPrintFile, resolvePrintSource } from "./spool.js";
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

const duplexSchema = z.enum([
  "one-sided",
  "two-sided-long-edge",
  "two-sided-short-edge",
]);

function createServer() {
  const server = new McpServer(
    { name: "print", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "print_file",
    {
      description:
        "Send a file to a CUPS printer via lp. Explicit tool call only — never auto-print. " +
        "Accepts exactly one of: absolute path under PRINT_SPOOL_DIR, http(s) URL (downloaded to spool), " +
        "or contentBase64 (written to spool). Supported types: PDF, PNG, JPG/JPEG.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute path on the host under PRINT_SPOOL_DIR (path-jailed). Preferred for local files.",
          ),
        url: z
          .string()
          .url()
          .optional()
          .describe("http(s) URL to download into the spool, then print."),
        contentBase64: z
          .string()
          .min(1)
          .optional()
          .describe("Base64-encoded file bytes (written under the spool, then printed)."),
        filename: z
          .string()
          .min(1)
          .optional()
          .describe("Optional filename (with extension) when using url or contentBase64."),
        copies: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of copies (default 1)."),
        duplex: duplexSchema
          .optional()
          .describe("Duplex / sides mode (alias of sides)."),
        sides: duplexSchema
          .optional()
          .describe("CUPS sides option (alias of duplex)."),
        printer: z
          .string()
          .min(1)
          .optional()
          .describe("CUPS queue name (default: CUPS_PRINTER / DEFAULT_PRINTER)."),
      },
    },
    async (args) => {
      return withToolTelemetry("print_file", async () => {
        const sources = [args.path, args.url, args.contentBase64].filter(Boolean);
        if (sources.length !== 1) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Provide exactly one of: path, url, contentBase64",
                }),
              },
            ],
          };
        }

        const config = getConfig();
        const sides = (args.sides ?? args.duplex) as DuplexMode | undefined;
        let resolved;
        try {
          resolved = await resolvePrintSource(config, {
            path: args.path,
            url: args.url,
            contentBase64: args.contentBase64,
            filename: args.filename,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
          };
        }

        try {
          const result = await printFile(config, {
            filePath: resolved.filePath,
            copies: args.copies,
            sides,
            printer: args.printer,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } finally {
          await cleanupResolvedPrintFile(config.printSpoolDir, resolved).catch(
            () => undefined,
          );
        }
      });
    },
  );

  server.registerTool(
    "list_printers",
    {
      description:
        "List CUPS printer queues (lpstat -p -d) so the agent can pick a printer. " +
        "Does not print anything.",
      inputSchema: {},
    },
    async () => {
      return withToolTelemetry("list_printers", async () => {
        const result = await listPrinters(getConfig());
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      });
    },
  );

  return server;
}

async function main() {
  startTelemetry();

  const PORT = parseInt(process.env.PORT ?? "8797", 10);
  const HOST = process.env.HOST ?? "0.0.0.0";

  const app = createMcpExpressApp({ host: HOST });
  const transports: Map<string, StreamableHTTPServerTransport> = new Map();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "print-mcp", version: "0.1.0" });
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
    console.error(`Print MCP server listening on http://${HOST}:${PORT}`);
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
