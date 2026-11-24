#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { telegramSearch } from "./search.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";

const toolDefinitions = [
  {
    name: "telegram_search",
    description:
      "Search the owner's Telegram archive (local tg-search index). " +
      "Returns matching fragments with chat title, type, dates, senders, a snippet, " +
      "and Telegram links (message deep link, chat link, or date only). " +
      "No LLM / ask: this is search-only and does not send the archive off the server.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query over the owner's Telegram archive" },
        chat_ids: {
          type: "array",
          items: { type: ["string", "number"] },
          description: "Optional chat id filter",
        },
        from: { type: "string", description: "Inclusive start date (YYYY-MM-DD or ISO)" },
        to: { type: "string", description: "Inclusive end date (YYYY-MM-DD or ISO)" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max hits (1-50, default 10)" },
      },
      required: ["query"],
    },
  },
];

const searchArgsSchema = z
  .object({
    query: z.string().min(1),
    chat_ids: z.array(z.union([z.string(), z.number()])).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

async function main() {
  startTelemetry();

  const server = new Server(
    { name: "telegram", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name !== "telegram_search") {
        return jsonResult({ ok: false, error: `Unknown tool: ${name}` });
      }
      return withToolTelemetry("telegram_search", async () => {
        const parsed = searchArgsSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return jsonResult({ ok: false, error: parsed.error.message });
        }
        try {
          const data = await telegramSearch(parsed.data);
          return jsonResult({ ok: true, data });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ ok: false, error: message });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResult({ ok: false, error: message });
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
