# Apple Calendar MCP

A Model Context Protocol (MCP) server for Apple Calendar (iCloud CalDAV). This server provides tools to list, create, update, and delete calendar events via the CalDAV protocol.

## Features

- **calendar_list** — List events in a time range (default: now to +2 days)
- **calendar_create_event** — Create events with title, times, location, notes, and alarms
- **calendar_update_event** — Update existing events (partial updates supported)
- **calendar_delete_event** — Delete events by UID or href

## Requirements

- Node.js 20+
- An iCloud account with an app-specific password

## Setup

### 1. Get iCloud CalDAV Credentials

1. Go to [Apple ID Account Management](https://appleid.apple.com/account/manage)
2. Generate an **app-specific password** for CalDAV access
3. Find your calendar URL in Calendar.app:
   - Right-click your calendar → "Get Info"
   - Copy the CalDAV URL (e.g., `https://caldav.icloud.com/12345678901/calendars/home/`)

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
ICLOUD_CALDAV_USERNAME=your-icloud-email@icloud.com
ICLOUD_CALDAV_PASSWORD=xxxx-xxxx-xxxx-xxxx
ICLOUD_CALDAV_CALENDAR_URL=https://caldav.icloud.com/YOUR_USER_ID/calendars/YOUR_CALENDAR/
USER_TIMEZONE=America/Chicago
```

### 3. Install Dependencies

```bash
npm install
```

## Running the Server

### Development (with tsx)

```bash
npm run dev
```

### Production (compiled)

```bash
npm run build
npm start
```

## Connecting to Grok Bot / Cursor

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "apple-calendar": {
      "command": "npx",
      "args": ["tsx", "/path/to/servers/apple-calendar/src/index.ts"],
      "env": {
        "ICLOUD_CALDAV_USERNAME": "your-email@icloud.com",
        "ICLOUD_CALDAV_PASSWORD": "xxxx-xxxx-xxxx-xxxx",
        "ICLOUD_CALDAV_CALENDAR_URL": "https://caldav.icloud.com/123/calendars/home/",
        "USER_TIMEZONE": "America/Chicago"
      }
    }
  }
}
```

Or with compiled output:

```json
{
  "mcpServers": {
    "apple-calendar": {
      "command": "node",
      "args": ["/path/to/servers/apple-calendar/dist/index.js"],
      "env": {
        "ICLOUD_CALDAV_USERNAME": "your-email@icloud.com",
        "ICLOUD_CALDAV_PASSWORD": "xxxx-xxxx-xxxx-xxxx",
        "ICLOUD_CALDAV_CALENDAR_URL": "https://caldav.icloud.com/123/calendars/home/",
        "USER_TIMEZONE": "America/Chicago"
      }
    }
  }
}
```

## Tool Reference

### calendar_list

List events in a time range.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| from | string | now | ISO datetime or YYYY-MM-DD (local day start) |
| to | string | now + 2 days | ISO datetime or YYYY-MM-DD (local day end) |
| limit | integer | 30 | Max events to return (1-100) |

### calendar_create_event

Create a new calendar event.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| title | string | Yes | Event title |
| start | string | Yes | Start time (naive = local, Z = UTC) |
| end | string | No | End time (default: start + 30 min) |
| notes | string | No | Event notes |
| alarm_minutes_before | number[] | No | Alert times (default: [60, 15]) |
| location_name | string | No | Place name |
| location_address | string | No | Address for LOCATION field |
| location_maps_url | string | No | Maps URL for description |
| location_lat | number | No | Latitude for GEO field |
| location_lon | number | No | Longitude for GEO field |

### calendar_update_event

Update an existing event. Only pass fields you want to change.

| Parameter | Type | Description |
|-----------|------|-------------|
| uid | string | Event UID (resolves href via CalDAV) |
| href | string | Event href (preferred if known) |
| title | string | New title |
| start | string | New start time |
| end | string | New end time |
| notes | string | New notes |
| alarm_minutes_before | number[] | New alerts ([] clears, null = defaults) |
| location_* | various | Location fields |

### calendar_delete_event

Delete an event.

| Parameter | Type | Description |
|-----------|------|-------------|
| uid | string | Event UID |
| href | string | Event href (preferred if known) |

## Limitations

- Does not support creating/updating recurring events or all-day events (listing them works)
- No duplicate-detection flow (creates as requested)
- Requires network access to iCloud CalDAV servers

## Testing

```bash
npm test
```

Tests cover ICS generation/parsing and timezone handling. They do not hit live iCloud.

## License

MIT
