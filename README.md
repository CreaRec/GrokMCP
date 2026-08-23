# GrokMCP

A monorepo of custom MCP (Model Context Protocol) servers for Grok Bot.

## Structure

```
GrokMCP/
├── servers/
│   └── apple-calendar/   # Apple Calendar (iCloud CalDAV) MCP
└── README.md
```

## Available Servers

### [Apple Calendar](./servers/apple-calendar/)

iCloud CalDAV integration for listing, creating, updating, and deleting calendar events.

**Tools:**
- `calendar_list` — List events in a time range
- `calendar_create_event` — Create calendar events
- `calendar_update_event` — Update existing events
- `calendar_delete_event` — Delete events

## Adding a New Server

1. Create a new directory under `servers/`:
   ```bash
   mkdir -p servers/my-new-server/src
   ```

2. Initialize with standard MCP structure:
   ```bash
   cd servers/my-new-server
   npm init -y
   ```

3. Add required dependencies:
   ```bash
   npm install @modelcontextprotocol/sdk zod
   npm install -D typescript tsx vitest @types/node
   ```

4. Create the server entry point at `src/index.ts`:
   ```typescript
   import { Server } from "@modelcontextprotocol/sdk/server/index.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   // ... implement your tools
   ```

5. Add a README documenting:
   - Required environment variables
   - Available tools and their parameters
   - How to connect to Grok Bot / Cursor

## Development

Each server is independent with its own `package.json`. To work on a server:

```bash
cd servers/apple-calendar
npm install
npm test        # Run tests
npm run dev     # Run with hot reload
npm run build   # Compile TypeScript
```

## License

MIT
