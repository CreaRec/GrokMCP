#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getTransactions, listAccounts } from "./config.js";
import { DateRangeError } from "./dates.js";
import { AccessUrlError } from "./access-url.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";

const toolDefinitions = [
  {
    name: "list_accounts",
    description:
      "List SimpleFIN Bridge accounts with balances (version=2, balances-only). " +
      "Returns id, name, currency, balance, available-balance, balance-date (ISO), and org name/domain. " +
      "Includes top-level SimpleFIN errors/errlist when present. Does not scrape banks. " +
      "Note: Bridge expects roughly ≤24 API requests/day — prefer caching over polling.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_transactions",
    description:
      "Fetch SimpleFIN Bridge transactions for a date range (max 90 days). " +
      "start/end are YYYY-MM-DD interpreted in America/Chicago; mapped to Unix start-date (inclusive) " +
      "and end-date (exclusive). Optional account id(s) and pending=true. " +
      "Returns flattened transactions with id, posted (ISO or null), amount, description, payee, memo, account id/name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        start: {
          type: "string",
          description:
            "Range start date YYYY-MM-DD (America/Chicago midnight, inclusive).",
        },
        end: {
          type: "string",
          description:
            "Range end date YYYY-MM-DD (America/Chicago midnight, exclusive per SimpleFIN). Max 90 days after start.",
        },
        account: {
          description:
            "Optional account id, or array of ids (repeatable SimpleFIN account= filter).",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        pending: {
          type: "boolean",
          description: "If true, include pending transactions (pending=1).",
        },
      },
      required: ["start", "end"],
    },
  },
];

const getTransactionsArgsSchema = z
  .object({
    start: z.string(),
    end: z.string(),
    account: z.union([z.string(), z.array(z.string())]).optional(),
    pending: z.boolean().optional(),
  })
  .strict();

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

async function main() {
  startTelemetry();

  const server = new Server(
    { name: "simplefin", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "list_accounts": {
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
        }

        case "get_transactions": {
          return withToolTelemetry("get_transactions", async () => {
            const parsed = getTransactionsArgsSchema.safeParse(args ?? {});
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
              const data = await getTransactions(parsed.data);
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
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }),
              },
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
