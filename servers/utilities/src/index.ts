#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getUtilityBills } from "./config.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";

const toolDefinitions = [
  {
    name: "utility_bills",
    description:
      "Read monthly electricity, water, and gas bills from CreaDashboard. " +
      "Returns the latest billed month vs the previous billed month (cost and consumption deltas). " +
      "If the newest month has no bill yet, it is flagged as unbilled instead of treating $0 as a real bill.",
    inputSchema: {
      type: "object" as const,
      properties: {
        months: {
          type: "integer",
          minimum: 2,
          maximum: 6,
          description:
            "Number of billed months to include in history (2-6). Comparison always uses the two most recent billed months.",
        },
      },
    },
  },
];

async function main() {
  startTelemetry();

  const server = new Server(
    { name: "utilities", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "utility_bills": {
          return withToolTelemetry("utility_bills", async () => {
            const schema = z.object({
              months: z.number().int().min(2).max(6).optional(),
            });
            const parsed = schema.safeParse(args ?? {});
            if (!parsed.success) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ ok: false, error: parsed.error.message }),
                  },
                ],
              };
            }

            try {
              const data = await getUtilityBills(parsed.data.months ?? 2);
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
        }

        default:
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }) },
            ],
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
      };
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
