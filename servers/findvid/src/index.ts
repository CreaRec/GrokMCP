#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getFindvidService } from "./service-factory.js";
import {
  startTelemetry,
  shutdownTelemetry,
  withToolTelemetry,
} from "./telemetry.js";

const toolDefinitions = [
  {
    name: "search",
    description:
      "Search Findvid (Telegram inline bot) for a movie/show. Returns the single best match " +
      "plus alternatives. Preferred flow: search → show user → list_voiceovers → user picks " +
      "voiceover only → list_qualities → agent picks max quality → confirm_and_forward " +
      "(no second user OK). After voiceover, qualities arrive on a new message — not the film. " +
      "Озвучка/Качество are chrome menu buttons, not voiceover names. " +
      "VIP/rate-limits/UI changes on Findvid can break button automation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Movie or series search query." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_voiceovers",
    description:
      "Select the search match in Findvid chat, open the Озвучка chrome submenu if needed, " +
      "and return real voiceover (озвучки) labels. Does not return chrome items like Озвучка/Качество/Поиск.",
    inputSchema: {
      type: "object" as const,
      properties: {
        resultId: { type: "string", description: "Optional inline result id." },
      },
    },
  },
  {
    name: "list_qualities",
    description:
      "Select a voiceover (studio). Wait for a NEW message with quality buttons (1080p/720p/…). " +
      "Does not treat post-voiceover preview/media as the film — returns real Nx p options. " +
      "Agent should then pick max quality and call confirm_and_forward without asking the user again.",
    inputSchema: {
      type: "object" as const,
      properties: {
        voiceover: { type: "string", description: "Optional voiceover label override." },
      },
    },
  },
  {
    name: "confirm_and_forward",
    description:
      "After voiceover + quality: click quality (film arrives on a NEW message after that click, " +
      "not after voiceover alone), forward the film video/document to the downloader bot. " +
      "Rejects tiny guide/howto clips and post-voiceover previews. Does not download. " +
      "Preferred: user confirmed voiceover only — pick max quality and call this immediately.",
    inputSchema: {
      type: "object" as const,
      properties: {
        resultId: { type: "string" },
        voiceover: { type: "string" },
        quality: { type: "string" },
      },
    },
  },
];

const searchArgs = z.object({ query: z.string() }).strict();
const voiceoverArgs = z.object({ resultId: z.string().optional() }).strict();
const qualityArgs = z.object({ voiceover: z.string().optional() }).strict();
const confirmArgs = z
  .object({
    resultId: z.string().optional(),
    voiceover: z.string().optional(),
    quality: z.string().optional(),
  })
  .strict();

function toolErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }],
  };
}

function fail(err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, error: toolErrorMessage(err) }),
      },
    ],
  };
}

async function main() {
  startTelemetry();

  const server = new Server(
    { name: "findvid", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "search": {
          return withToolTelemetry("search", async () => {
            const parsed = searchArgs.safeParse(args ?? {});
            if (!parsed.success) return fail(parsed.error.message);
            try {
              const service = await getFindvidService();
              return ok(await service.search(parsed.data.query));
            } catch (err) {
              return fail(err);
            }
          });
        }
        case "list_voiceovers": {
          return withToolTelemetry("list_voiceovers", async () => {
            const parsed = voiceoverArgs.safeParse(args ?? {});
            if (!parsed.success) return fail(parsed.error.message);
            try {
              const service = await getFindvidService();
              return ok(await service.listVoiceovers(parsed.data));
            } catch (err) {
              return fail(err);
            }
          });
        }
        case "list_qualities": {
          return withToolTelemetry("list_qualities", async () => {
            const parsed = qualityArgs.safeParse(args ?? {});
            if (!parsed.success) return fail(parsed.error.message);
            try {
              const service = await getFindvidService();
              return ok(await service.listQualities(parsed.data));
            } catch (err) {
              return fail(err);
            }
          });
        }
        case "confirm_and_forward": {
          return withToolTelemetry("confirm_and_forward", async () => {
            const parsed = confirmArgs.safeParse(args ?? {});
            if (!parsed.success) return fail(parsed.error.message);
            try {
              const service = await getFindvidService();
              return ok(await service.confirmAndForward(parsed.data));
            } catch (err) {
              return fail(err);
            }
          });
        }
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return fail(error);
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
