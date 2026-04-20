/**
 * Cleans up duplicate rows in dbo.schedule_conflicts.
 *
 * Keeps exactly one record per (truck_number, hold_id, conflict_start, conflict_end)
 * combination — the one with the earliest id (NEWID is random, so we use MIN(id)).
 * All other rows for that combination are deleted.
 *
 * Run with:  node scripts/dedup-conflicts.js
 */

const fs   = require('fs')
const path = require('path')
const sql  = require('mssql')

// ── Load env without dotenv dependency ───────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env.local')
const envFile = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, 'utf8')
  : fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')

for (const line of envFile.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx === -1) continue
  const key = trimmed.slice(0, eqIdx).trim()
  let   val = trimmed.slice(eqIdx + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  if (!process.env[key]) process.env[key] = val
}

// ── DB config ─────────────────────────────────────────────────────────────────
const config = {
  server:   process.env.MSSQL_SERVER,
  port:     parseInt(process.env.MSSQL_PORT || '1433', 10),
  database: process.env.MSSQL_DATABASE,
  user:     process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options:  { encrypt: true, trustServerCertificate: false },
}

async function main() {
  console.log('Connecting to', config.server, '/', config.database)
  const pool = await sql.connect(config)

  // Count duplicates before cleanup
  const countResult = await pool.request().query(`
    SELECT COUNT(*) AS total_dupes
    FROM (
      SELECT truck_number, hold_id, conflict_start, conflict_end,
             COUNT(*) AS cnt
      FROM dbo.schedule_conflicts
      GROUP BY truck_number, hold_id, conflict_start, conflict_end
      HAVING COUNT(*) > 1
    ) dupes
  `)
  const dupeGroups = countResult.recordset[0].total_dupes
  console.log(`Found ${dupeGroups} group(s) with duplicates`)

  if (dupeGroups === 0) {
    console.log('Nothing to clean up.')
    await pool.close()
    return
  }

  // Delete all but the MIN(id) per group
  const deleteResult = await pool.request().query(`
    DELETE FROM dbo.schedule_conflicts
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM dbo.schedule_conflicts
      GROUP BY truck_number, hold_id, conflict_start, conflict_end
    )
  `)
  console.log(`Deleted ${deleteResult.rowsAffected[0]} duplicate row(s)`)

  // Confirm
  const verify = await pool.request().query(`
    SELECT COUNT(*) AS remaining FROM dbo.schedule_conflicts
  `)
  console.log(`Rows remaining in dbo.schedule_conflicts: ${verify.recordset[0].remaining}`)

  await pool.close()
  console.log('Done.')
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
