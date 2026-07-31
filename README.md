# Lime Media Scheduling App

Internal scheduling and availability tool for the Lime Media truck fleet. Built on Next.js 14, connected to the LED app's Azure SQL database, Samsara GPS, and a Prisma/SQL Server holds database.

---

## How the Core Intelligence Works

The app answers three questions at all times:
1. **Where is each truck?** — live Samsara GPS
2. **What is it doing?** — LED app schedule (Azure SQL) + holds placed in this app (Prisma)
3. **When is it free?** — gaps between LED shifts and holds

These three sources are combined and fed to the AI assistant on every message.

---

## Key Files

### `lib/scheduleQuery.ts`
Contains the SQL queries that read directly from the LED app's Azure SQL database.

**`SCHEDULED_QUERY`**
Pulls every shift block for every truck in a ±30/60 day window. Joins:
- `dbo.program_schedule` — the actual shift rows (truck, start/end time)
- `dbo.client_programs` — the program name (e.g. "ATT FIBER", "TOYOTA")
- `dbo.client_program_markets` — market, state, and standard market name for the shift

This is what drives the colored blocks on the Schedule Grid.

**`ALL_TRUCKS_QUERY`**
Gets the full active truck list, including trucks with no current schedule.

**`CHAT_CONTEXT_QUERY`**
A per-truck snapshot used by the AI. For each truck it returns:
- `today_status` — `SCHEDULED` if there is a `program_schedule` row covering today, otherwise `AVAILABLE`
- Current program name and market
- Last known market from the most recent past shift (for context when a truck is idle)

### `lib/samsaraService.ts`
Calls the Samsara Fleet API live on every request (no cache). Returns a map of truck number → `{ city, state, formatted_address, latitude, longitude }`.

Vehicle names in Samsara follow the format `LED- XXXX` (note: space after the dash). The service strips `LED-`, trims whitespace, and zero-pads to 4 digits to match the database `truck_number` format (e.g. `LED- 825` → `0825`).

### `app/api/schedule/route.ts`
The main data API for the Schedule Grid. On each request it:
1. Queries the LED database for trucks and schedule blocks (cached 5 min, bypassed with `?force=1`)
2. Fetches live GPS from Samsara (never cached)
3. Reads holds from Prisma (always fresh)
4. Determines each truck's `last_known_market` using this priority:
   - Standard market name from current/future LED schedule
   - GPS city + state (Samsara)
   - Market from the most recent hold in this app
   - "Unassigned"

### `app/api/chat/route.ts` — `buildScheduleContext()`
This is what the AI sees on every message. It runs three queries in parallel and assembles a plain-text context block:

```
TRUCK STATUS (today: 2026-05-15):
- Truck 0044: SCHEDULED | GPS: Nashville, TN | program="ATT FIBER" | market=Nashville, TN | scheduled 2026-05-01 → 2026-05-31
- Truck 0825: AVAILABLE | GPS: Bloomington, MN | Last market: Minneapolis, MN
- Truck 0786: AVAILABLE | Location unknown

ALL HOLDS & COMMITMENTS (12 total):
  Truck 0786: HOLD for "Nike" in Oklahoma City, OK (2026-05-20 → 2026-06-05)
  Truck 7245: ATT_SOFT for "AT&T" in  (2026-06-01 → 2026-06-30)
```

Location priority in the context:
1. Live Samsara GPS (`GPS: City, ST`)
2. Last known market from the LED schedule (`Last market: X`)
3. `Location unknown`

The AI is instructed never to guess or infer a truck's location — it can only report what appears explicitly in this context.

---

## Truck Status Definitions

| Status | Source | Meaning |
|---|---|---|
| SCHEDULED | LED app (`program_schedule`) | Assigned to a client program |
| AVAILABLE | LED app (no row for today) | No active program |
| HOLD | This app (Prisma) | Tentatively reserved by the sales team |
| COMMITTED | This app (Prisma) | Confirmed booking |
| ATT_SOFT | This app (Prisma, auto-created) | Soft hold for AT&T trucks for the following month |

---

## Availability Logic

A truck is considered **available for a date range** if:
- No `program_schedule` row in the LED database covers any day in that range
- No HOLD, COMMITTED, or ATT_SOFT row in Prisma overlaps that range

The AI checks both sources and reports conflicts from either. The Schedule Grid renders both as colored blocks on the same timeline.

---

## Data Sources

| Data | Source | Refresh |
|---|---|---|
| Shift schedule | Azure SQL (`dbo.program_schedule`) | 5-min cache (grid), live (AI chat) |
| Truck list | Azure SQL (`dbo.trucks`) | 5-min cache |
| Markets / programs | Azure SQL (`dbo.client_program_markets`) | 5-min cache |
| GPS locations | Samsara Fleet API | Always live, no cache |
| Holds / commitments | Prisma (SQL Server) | Always live |

---

## Internal API (MCP Server Integration)

Endpoints for service-to-service consumption by the Lime MCP server. These are **not** part of the UI application — they exist to let external integration layers (starting with OneScreen) query truck inventory, availability, and create holds programmatically.

### Authentication

All internal endpoints require the service-level bearer token:

```
Authorization: Bearer <value of INTERNAL_API_KEY env var>
```

This is separate from NextAuth. The MCP server authenticates as a privileged internal service.

#### Per-user MCP tokens (V2)

Individual MCP users are identified via tokens stored in the `mcp_tokens` table. Each token is tied to either an `app_users` record (internal staff) or an `app_client_users` record (external customers like OneScreen), distinguished by the `user_type` column (`app_user` | `client_user`).

The MCP server validates user tokens by calling the `validate-token` endpoint, then passes the resolved `user_id` and `user_type` via `X-Acting-User-Id` and `X-Acting-User-Type` headers on write operations.

**Behavior differs by user type:**
- **`app_user`** — creates actual holds in `app_holds` (same as the internal UI)
- **`client_user`** — creates hold *requests* in `app_hold_requests` (same as the client portal), which go through the existing approval flow

**Minting a new token:**

```bash
# For internal staff:
npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mint-mcp-token.ts app_user <user_id> "label"

# For external customers:
npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mint-mcp-token.ts client_user <user_id> "OneScreen production"
```

The raw token is printed once to stdout. Only the bcrypt hash is stored in the database. Hand the raw token to the MCP consumer.

### `GET /api/v1/internal/inventory`

Returns all active LED trucks with their projected market.

**Request:** No parameters.

**Response:**
```json
{
  "trucks": [
    {
      "unit_id": "0042",
      "projected_market": "Dallas-Ft. Worth, TX",
      "projected_as_of": "2026-06-12T14:23:00.000Z",
      "is_active": true
    }
  ],
  "generated_at": "2026-06-12T14:23:00.000Z"
}
```

`projected_market` uses the same cascade as the Schedule Grid: most recent LED schedule market → earliest hold market → live Samsara GPS city. It is a point-in-time snapshot, not a permanent attribute. Can be cached aggressively (changes rarely within a day).

### `GET /api/v1/internal/availability`

Returns booked (unavailable) intervals for trucks within a date range.

**Query parameters:**
| Param | Required | Description |
|---|---|---|
| `start_date` | Yes | ISO date (`YYYY-MM-DD`) |
| `end_date` | Yes | ISO date (`YYYY-MM-DD`) |
| `unit_ids` | No | Comma-separated truck numbers (e.g. `0042,0055`). Omit for all trucks. |

**Response:**
```json
{
  "trucks": [
    {
      "unit_id": "0042",
      "projected_market_during_range": "Dallas-Ft. Worth, TX",
      "booked_intervals": [
        {
          "start_date": "2026-07-05",
          "end_date": "2026-07-18",
          "status": "unavailable"
        }
      ]
    }
  ],
  "query_range": { "start_date": "2026-07-01", "end_date": "2026-08-31" },
  "generated_at": "2026-06-12T14:23:00.000Z"
}
```

All internal status distinctions (SCHEDULE, HOLD, COMMITTED, ATT_SOFT) are collapsed to a single `"unavailable"` status. No client names, program names, notes, or other internal-only fields are returned. Overlapping or adjacent intervals are merged.

### `POST /api/v1/internal/auth/validate-token`

Validates an MCP user token. Called by the MCP server to resolve a user's identity before forwarding requests.

**Request headers:**
- `Authorization: Bearer <INTERNAL_API_KEY>` (service-level auth)
- `X-MCP-Token: <raw user token>` (the token to validate)

**Response (200) for `app_user`:**
```json
{
  "user_id": "clxyz123",
  "user_type": "app_user",
  "email": "staff@lime-media.com",
  "name": "Staff Name",
  "label": "Internal dev",
  "token_id": "cltoken456"
}
```

**Response (200) for `client_user`:**
```json
{
  "user_id": "clxyz789",
  "user_type": "client_user",
  "username": "onescreen",
  "company_name": "OneScreen",
  "label": "OneScreen production",
  "token_id": "cltoken456"
}
```

Returns `401` if the token is missing, invalid, or revoked.

### `POST /api/v1/internal/holds`

Creates a hold or hold request on behalf of an MCP user. Behavior depends on `user_type`:

- **`app_user`** — creates an actual hold in `app_holds` with conflict checking (same as the internal UI)
- **`client_user`** — creates a hold *request* in `app_hold_requests` (same as the client portal), triggers email notification and Google Sheets logging

**Request headers:**
- `Authorization: Bearer <INTERNAL_API_KEY>`
- `X-Acting-User-Id: <user_id>` (resolved from validate-token)
- `X-Acting-User-Type: app_user | client_user` (defaults to `app_user`)

**Request body:**
```json
{
  "truck_number": "0042",
  "market": "Dallas-Ft. Worth, TX",
  "state": "TX",
  "client_name": "Acme Corp",
  "start_date": "2026-08-01",
  "end_date": "2026-08-15",
  "status": "HOLD",
  "notes": "Optional notes"
}
```

For `app_user`: requires `truck_number`, `market`, `state`, `client_name`, `start_date`, `end_date`.
For `client_user`: requires `truck_number`, `start_date`, `end_date` (market/state optional, matching client portal).

**Response (201):** The created record. Includes `"type": "hold"` or `"type": "hold_request"` to distinguish.
**Response (409):** Conflict (app_user holds only) — truck has an existing hold or LED schedule in the requested date range.

### `POST /api/v1/internal/query-log`

Logs an MCP tool invocation for analytics. The MCP server calls this on every tool call (fire-and-forget — do not block the tool response on this succeeding).

**Request headers:**
- `Authorization: Bearer <INTERNAL_API_KEY>`

**Request body:**
```json
{
  "user_id": "clxyz123",
  "user_type": "client_user",
  "token_id": "cltoken456",
  "tool_name": "check_availability",
  "request_params": { "start_date": "2026-08-01", "end_date": "2026-08-31" },
  "response_summary": { "available_count": 12 },
  "outcome": "success",
  "latency_ms": 342
}
```

Required: `tool_name`, `outcome` (`success` | `no_availability` | `error`), `latency_ms`.
Optional: `user_id`, `token_id`, `request_params`, `response_summary`.

**Response (201):** `{ "id": "<log entry id>" }`

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `MSSQL_*` | Azure SQL connection (LED app database) |
| `DATABASE_URL` | Prisma connection string (holds database) |
| `SAMSARA_API_TOKEN` | Samsara Fleet API authentication |
| `ANTHROPIC_API_KEY` | Claude AI (chat assistant) |
| `NEXTAUTH_SECRET` | NextAuth session secret |
| `INTERNAL_API_KEY` | Bearer token for `/api/v1/internal/*` endpoints (MCP server) |

---

## Deployment

```bash
# Local development
npm run dev

# Deploy to production
vercel --prod
```

The app is hosted on Vercel. Pushing to `main` on GitHub does not auto-deploy — run `vercel --prod` manually after committing.
