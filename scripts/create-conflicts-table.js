/**
 * Creates the schedule_conflicts table in Azure SQL.
 * Run once: node scripts/create-conflicts-table.js
 */

// Load env vars without requiring dotenv
const fs = require('fs')
const path = require('path')

const envFile = path.join(__dirname, '..', '.env')
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach((line) => {
      const eq = line.indexOf('=')
      if (eq === -1 || line.trim().startsWith('#')) return
      const key = line.slice(0, eq).trim()
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key && !process.env[key]) process.env[key] = val
    })
}

const sql = require('mssql')

const config = {
  server:   process.env.MSSQL_SERVER   || 'limemediauat.database.windows.net',
  port:     Number(process.env.MSSQL_PORT) || 1433,
  database: process.env.MSSQL_DATABASE || 'limemediauat',
  user:     process.env.MSSQL_USER     || 'limeuatadmin',
  password: process.env.MSSQL_PASSWORD || '',
  options:  { encrypt: true, trustServerCertificate: false },
}

const SQL = `
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='schedule_conflicts' AND xtype='U')
CREATE TABLE dbo.schedule_conflicts (
  id                NVARCHAR(36)  NOT NULL PRIMARY KEY DEFAULT NEWID(),
  hold_id           NVARCHAR(36)  NOT NULL,
  truck_number      NVARCHAR(50)  NOT NULL,
  conflict_start    DATE          NOT NULL,
  conflict_end      DATE          NOT NULL,
  hold_client       NVARCHAR(255) NULL,
  hold_market       NVARCHAR(255) NULL,
  scheduled_program NVARCHAR(255) NULL,
  status            NVARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  detected_at       DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
  resolved_at       DATETIME2     NULL,
  resolved_by       NVARCHAR(36)  NULL,
  notified_at       DATETIME2     NULL,
  CONSTRAINT FK_conflicts_hold
    FOREIGN KEY (hold_id) REFERENCES dbo.app_holds(id) ON DELETE CASCADE
)
`

sql
  .connect(config)
  .then((pool) => pool.request().query(SQL))
  .then(() => {
    console.log('✓ schedule_conflicts table created (or already existed)')
    process.exit(0)
  })
  .catch((e) => {
    console.error('✗ Error:', e.message)
    process.exit(1)
  })
