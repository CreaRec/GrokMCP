#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getUtilityBills, getWaterDaily } from "./config.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";
import { WaterDailyArgError } from "./water-daily.js";

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
  {
    name: "water_daily",
    description:
      "Read daily water usage (gallons) from CreaDashboard. " +
      "Provide start+end (YYYY-MM-DD), or month (YYYY-MM), or omit dates for the current calendar month in America/Chicago. " +
      "Multi-month ranges are fetched month-by-month and merged. Does not scrape WaterSmart.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start: {
          type: "string",
          description: "Range start date YYYY-MM-DD (requires end). Mutually exclusive with month.",
        },
        end: {
          type: "string",
          description: "Range end date YYYY-MM-DD (requires start). Mutually exclusive with month.",
        },
        month: {
          type: "string",
          description: "Single month YYYY-MM. Mutually exclusive with start/end.",
        },
      },
    },
  },
];

const waterDailyArgsSchema = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
    month: z.string().optional(),
  })
  .strict();

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

        case "water_daily": {
          return withToolTelemetry("water_daily", async () => {
            const parsed = waterDailyArgsSchema.safeParse(args ?? {});
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
              const data = await getWaterDaily(parsed.data);
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
