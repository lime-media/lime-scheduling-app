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
MSSQL_DATABASE="limemediauat"
MSSQL_USER="limeuatadmin"
MSSQL_PASSWORD="YOUR_PASSWORD"
```

## 2. Create the Three New Tables in Azure SQL

> **IMPORTANT:** Do NOT run `prisma db push` or `prisma migrate` — those commands
> inspect the entire database and may attempt to drop or alter existing tables.
>
> Instead, run the safe SQL script below. It uses `IF NOT EXISTS` guards on each
> table and will no-op if the tables already exist. It does not touch any
> `led_app_*` or `samsara_*` tables.

Run `prisma/create-new-tables.sql` against limemediauat using any SQL client:

**Option A — sqlcmd (CLI):**
```bash
sqlcmd -S limemediauat.database.windows.net -d limemediauat \
       -U limeuatadmin -P 'YOUR_PASSWORD' \
       -i prisma/create-new-tables.sql
```

**Option B — Azure Data Studio / SSMS:**
Open `prisma/create-new-tables.sql` and execute it against the limemediauat database.

**Option C — VS Code SQL Server extension:**
Connect to limemediauat, open the file, right-click → Run Query.

The script creates:
- `dbo.app_users`
- `dbo.app_holds`
- `dbo.app_audit_logs`

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

### New Tables (managed by this app — created via SQL script)
- `dbo.app_users` — Login accounts with SALES or OPERATIONS role
- `dbo.app_holds` — Truck holds (HOLD or COMMITTED status)
- `dbo.app_audit_logs` — Full audit trail of all hold actions

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
