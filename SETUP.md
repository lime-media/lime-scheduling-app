# Lime Media Scheduling Assistant — Setup Guide

## Prerequisites
- Node.js 18+
- Access to Azure SQL (limemediauat.database.windows.net)
- Anthropic API key

## 1. Configure Environment Variables

`.env.local` should already be filled in. If starting fresh, set:

```
DATABASE_URL="sqlserver://limemediauat.database.windows.net:1433;database=limemediauat;user=limeuatadmin;password=YOUR_PASSWORD;encrypt=true;trustServerCertificate=false"
NEXTAUTH_SECRET="<output of: openssl rand -base64 32>"
NEXTAUTH_URL="http://localhost:3000"
ANTHROPIC_API_KEY="sk-ant-..."

MSSQL_SERVER="limemediauat.database.windows.net"
MSSQL_PORT=1433
MSSQL_DATABASE="limemediauat_PROD"
MSSQL_USER="limeuatadmin"
MSSQL_PASSWORD="YOUR_PASSWORD"
```

## 2. Create the App Tables in Azure SQL

> **IMPORTANT:** Do NOT run `prisma db push` or `prisma migrate deploy` — those
> commands inspect the entire database and may attempt to drop or alter existing
> tables (this DB also holds many non-Prisma legacy tables Prisma doesn't know
> about — `led_app_*`, `samsara_*`, etc.).
>
> Instead, run the SQL scripts below in order, by hand, against limemediauat.
> Every statement uses `IF NOT EXISTS` / `COL_LENGTH` guards, so scripts are
> safe to re-run and will no-op for anything that already exists. None of them
> touch `led_app_*` or `samsara_*` tables.

Schema changes now live as numbered migrations under `prisma/migrations/`
(the historical flat `prisma/*.sql` scripts are still there and still valid —
new changes go in `prisma/migrations/` going forward). Run them **in order**
against limemediauat using any SQL client:

1. `prisma/create-new-tables.sql` — `app_users`, `app_holds`, `app_audit_logs`
2. `prisma/migrations/20260420000001_add_schedule_conflicts_table/migration.sql` — `schedule_conflicts`
3. `prisma/create-chat-tables.sql` — `chat_conversations`, `chat_messages`
4. `prisma/migrations/20260706000000_add_client_users_and_hold_requests/migration.sql` — `app_client_users`, `app_hold_requests`
5. `prisma/mcp-v2-migration.sql` — `app_holds.origination`, `mcp_tokens`, `mcp_query_log`
6. `prisma/migrations/20260720000000_add_sfdc_columns_to_holds/migration.sql` — `app_holds.sfdc_opportunity_id`, `app_holds.sfdc_hold_exp`
7. `prisma/migrations/20260724000000_add_source_column/migration.sql` — `source` on `app_holds` and `app_hold_requests`
8. `prisma/mcp-v2-client-users-migration.sql` — `mcp_tokens.user_type`, `mcp_query_log.user_type`, drops hard FKs
9. `prisma/mcp-widen-user-id-migration.sql` — widens `user_id` to `NVARCHAR(255)` on `mcp_tokens`/`mcp_query_log`
10. `prisma/migrations/20260810000000_add_client_chat_tables/migration.sql` — `client_chat_conversations`, `client_chat_messages` (**not yet applied anywhere** — required by the in-progress client-portal AI chat feature; run this before that code path goes live)

**Option A — sqlcmd (CLI), one file at a time:**
```bash
sqlcmd -S limemediauat.database.windows.net -d limemediauat \
       -U limeuatadmin -P 'YOUR_PASSWORD' \
       -i prisma/create-new-tables.sql
# repeat for each file above, in order
```

**Option B — Azure Data Studio / SSMS:**
Open each file and execute it against the limemediauat database, in order.

**Option C — VS Code SQL Server extension:**
Connect to limemediauat, open each file, right-click → Run Query, in order.

> On a database that's already up to date (e.g. `limemediaprod`), all of the
> above are safe no-ops. They matter most for standing up a **new** database
> from scratch (fresh UAT/dev environment) — running them in order is what
> reconstructs the full current schema.
>
> `prisma/migrations/` uses Prisma's standard migration folder format so the
> history is browsable with tooling, but files inside it are still meant to be
> run by hand like the rest — never via `prisma migrate deploy` against this DB.

## 3. Generate Prisma Client

```bash
npm run db:generate
```

This generates the TypeScript client from the schema — it does **not** touch the database.

## 4. Seed Default Users

```bash
npm run db:seed
```

Default credentials (change passwords after first login):
- **Operations Admin**: admin@limemedia.com / `LimeMedia2024!`
- **Sales User**: sales@limemedia.com / `LimeMedia2024!`

## 5. Run Development Server

```bash
npm run dev
```

Open http://localhost:3000 — you'll be redirected to /login.

---

## Architecture

### Data Flow
```
Azure SQL (read-only existing tables) ──► /api/schedule ──► Dashboard Grid
                                              │
Azure SQL (app_holds, app_users) ◄──────────┘
                                              │
Anthropic Claude API ◄── /api/chat ──────────┘
```

### New Tables (managed by this app — created via SQL script, see step 2 above)
- `dbo.app_users` — Login accounts with SALES or OPERATIONS role
- `dbo.app_holds` — Truck holds (HOLD or COMMITTED status)
- `dbo.app_audit_logs` — Full audit trail of all hold actions
- `dbo.app_client_users` — Client portal login accounts
- `dbo.app_hold_requests` — Client-submitted hold requests (PENDING/APPROVED/REJECTED)
- `dbo.mcp_tokens`, `dbo.mcp_query_log` — MCP server auth + telemetry
- `dbo.chat_conversations`, `dbo.chat_messages` — Internal AI chat history
- `dbo.client_chat_conversations`, `dbo.client_chat_messages` — Client-portal AI chat history (not yet deployed — see step 2, item 10)
- `dbo.schedule_conflicts` — Hold-vs-real-schedule conflict records (`/conflicts` page)

### Existing Tables (read-only, never modified)
- `dbo.led_app_trucks`
- `dbo.samsara_vehicle_routes`
- `dbo.led_app_program_schedule`
- `dbo.led_app_client_programs`
- `dbo.led_app_client_program_markets`

---

## Usage

### Schedule Grid
- Grey = Available, Green = Scheduled, Yellow = Hold, Red = Committed
- Click any cell to see details in the right panel
- **Click & drag** across cells in a truck row to select a date range → hold modal appears
- Filter by state, market, date range, or status

### AI Chat
- Ask natural language questions: "Which trucks are available in Texas next week?"
- The AI receives current schedule + holds as context on every message

### Holds Management (/holds)
- View all holds and commitments
- Operations users can edit/release any hold
- Sales users can only modify their own holds

---

## Available Scripts

```bash
npm run dev           # Start dev server
npm run build         # Production build
npm run db:generate   # Regenerate Prisma client (safe, no DB changes)
npm run db:seed       # Seed default users (run AFTER SQL script)
npm run db:studio     # Open Prisma Studio GUI (read/write app tables only)
```

### What NOT to run
```bash
# DO NOT RUN — will attempt to modify the live database schema:
npx prisma db push
npx prisma migrate dev
npx prisma migrate deploy
```
