#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { listPrinters, printFile, type DuplexMode } from "./cups.js";
import { cleanupResolvedPrintFile, resolvePrintSource } from "./spool.js";
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

const printFileSchema = z
  .object({
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    contentBase64: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    copies: z.number().int().min(1).max(100).optional(),
    duplex: duplexSchema.optional(),
    sides: duplexSchema.optional(),
    printer: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const sources = [value.path, value.url, value.contentBase64].filter(Boolean);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of: path, url, contentBase64",
      });
    }
  });

const toolDefinitions = [
  {
    name: "print_file",
    description:
      "Send a file to a CUPS printer via lp. Explicit tool call only — never auto-print. " +
      "Accepts exactly one of: absolute path under PRINT_SPOOL_DIR, http(s) URL (downloaded to spool), " +
      "or contentBase64 (written to spool). Supported types: PDF, PNG, JPG/JPEG.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path on the host under PRINT_SPOOL_DIR (path-jailed). Preferred for local files.",
        },
        url: {
          type: "string",
          description: "http(s) URL to download into the spool, then print.",
        },
        contentBase64: {
          type: "string",
          description: "Base64-encoded file bytes (written under the spool, then printed).",
        },
        filename: {
          type: "string",
          description: "Optional filename (with extension) when using url or contentBase64.",
        },
        copies: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Number of copies (default 1).",
        },
        duplex: {
          type: "string",
          enum: ["one-sided", "two-sided-long-edge", "two-sided-short-edge"],
          description: "Duplex / sides mode (alias of sides).",
        },
        sides: {
          type: "string",
          enum: ["one-sided", "two-sided-long-edge", "two-sided-short-edge"],
          description: "CUPS sides option (alias of duplex).",
        },
        printer: {
          type: "string",
          description: "CUPS queue name (default: CUPS_PRINTER / DEFAULT_PRINTER).",
        },
      },
    },
  },
  {
    name: "list_printers",
    description:
      "List CUPS printer queues (lpstat -p -d) so the agent can pick a printer. " +
      "Does not print anything.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

function jsonContent(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

async function handlePrintFile(args: unknown) {
  const parsed = printFileSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return jsonContent({ ok: false, error: parsed.error.message });
  }

  const config = getConfig();
  const sides = (parsed.data.sides ?? parsed.data.duplex) as DuplexMode | undefined;
  let resolved;
  try {
    resolved = await resolvePrintSource(config, {
      path: parsed.data.path,
      url: parsed.data.url,
      contentBase64: parsed.data.contentBase64,
      filename: parsed.data.filename,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonContent({ ok: false, error: message });
  }

  try {
    const result = await printFile(config, {
      filePath: resolved.filePath,
      copies: parsed.data.copies,
      sides,
      printer: parsed.data.printer,
    });
    return jsonContent(result);
  } finally {
    await cleanupResolvedPrintFile(config.printSpoolDir, resolved).catch(
      () => undefined,
    );
  }
}

async function main() {
  startTelemetry();

  const server = new Server(
    { name: "print", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "print_file":
          return withToolTelemetry("print_file", () => handlePrintFile(args));

        case "list_printers":
          return withToolTelemetry("list_printers", async () => {
            const result = await listPrinters(getConfig());
            return jsonContent(result);
          });

        default:
          return jsonContent({ ok: false, error: `Unknown tool: ${name}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonContent({ ok: false, error: message });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await shutdownTelemetry();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await shutdownTelemetry();
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await shutdownTelemetry();
  process.exit(1);
});
