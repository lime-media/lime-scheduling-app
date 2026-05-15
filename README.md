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

## Environment Variables

| Variable | Purpose |
|---|---|
| `MSSQL_*` | Azure SQL connection (LED app database) |
| `DATABASE_URL` | Prisma connection string (holds database) |
| `SAMSARA_API_TOKEN` | Samsara Fleet API authentication |
| `ANTHROPIC_API_KEY` | Claude AI (chat assistant) |
| `NEXTAUTH_SECRET` | NextAuth session secret |

---

## Deployment

```bash
# Local development
npm run dev

# Deploy to production
vercel --prod
```

The app is hosted on Vercel. Pushing to `main` on GitHub does not auto-deploy — run `vercel --prod` manually after committing.
