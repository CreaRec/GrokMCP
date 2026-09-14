#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { preparePrintReadyFile } from "./convert.js";
import { listPrinters, printFile, type DuplexMode } from "./cups.js";
import { cleanupResolvedPrintFile, resolvePrintSource, type ResolvedPrintFile } from "./spool.js";
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
import {
  buildUploadInfoPayload,
  handlePrintUpload,
  PRINT_UPLOAD_PATH,
} from "./upload.js";

const duplexSchema = z.enum([
  "one-sided",
  "two-sided-long-edge",
  "two-sided-short-edge",
]);

const PRINT_FILE_DESCRIPTION =
  "Send a file to a CUPS printer via lp. Explicit tool call only — never auto-print. " +
  "Accepts exactly one of: absolute path under PRINT_SPOOL_DIR, http(s) URL (downloaded to spool), " +
  "or contentBase64 (written to spool). " +
  "For large files (≈30KB+), prefer HTTP POST/PUT /print/upload (see print_upload_url) or url — " +
  "avoid contentBase64 (MCP JSON may truncate). " +
  "Print-ready: PDF, PNG, JPG/JPEG. Converted to PDF in-container via LibreOffice: TXT, DOCX, ODT, RTF, DOC.";

function createServer() {
  const server = new McpServer(
    { name: "print", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "print_file",
    {
      description: PRINT_FILE_DESCRIPTION,
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
          .describe(
            "Base64-encoded file bytes (written under the spool, then printed). " +
              "Avoid for large docs — use /print/upload or url instead.",
          ),
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
        let resolved: ResolvedPrintFile | undefined;
        try {
          resolved = await resolvePrintSource(config, {
            path: args.path,
            url: args.url,
            contentBase64: args.contentBase64,
            filename: args.filename,
          });
          resolved = await preparePrintReadyFile(config, resolved);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (resolved) {
            await cleanupResolvedPrintFile(config.printSpoolDir, resolved).catch(
              () => undefined,
            );
          }
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

  server.registerTool(
    "print_upload_url",
    {
      description:
        "Return the HTTP upload endpoint for large print jobs (Word/PDF/etc). " +
        "Agents should stream files via multipart POST or raw PUT to this URL instead of " +
        "stuffing contentBase64 into print_file. Does not print by itself.",
      inputSchema: {
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe(
            "Optional public base URL of this server (default: http://127.0.0.1:$PORT).",
          ),
      },
    },
    async (args) => {
      return withToolTelemetry("print_upload_url", async () => {
        const config = getConfig();
        const port = process.env.PORT ?? "8797";
        const baseUrl = args.baseUrl?.trim() || `http://127.0.0.1:${port}`;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                buildUploadInfoPayload(baseUrl, Boolean(config.uploadToken)),
              ),
            },
          ],
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

  // Streamed file upload (multipart POST or raw PUT) — prefer over contentBase64 for large docs.
  app.post(PRINT_UPLOAD_PATH, (req: Request, res: Response) => {
    void handlePrintUpload(req, res);
  });
  app.put(PRINT_UPLOAD_PATH, (req: Request, res: Response) => {
    void handlePrintUpload(req, res);
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
    console.error(`Print upload: http://${HOST}:${PORT}${PRINT_UPLOAD_PATH}`);
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
