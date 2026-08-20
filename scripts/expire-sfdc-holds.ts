/**
 * One-off / manual runner for the SFDC hold-expiry sweep — normally run
 * automatically every hour by lib/cronJob.ts's refreshCache(). Use this to
 * trigger it immediately instead of waiting for the next cron tick, e.g.
 * right after this feature deploys, so already-past-due holds (sfdc_hold_exp
 * in the past, status still HOLD) flip to EXPIRED without waiting on a
 * server restart or the next warm hourly tick.
 *
 * Usage:
 *   npx tsx scripts/expire-sfdc-holds.ts
 *
 * Loads env the same way `next dev`/`next build` do (via @next/env, reading
 * .env.local) — so it targets whichever DATABASE_URL your local env currently
 * points at. Check that before running.
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { expireSfdcHolds } from '@/lib/scheduleCache'
import { prisma } from '@/lib/prisma'

async function main() {
  const count = await expireSfdcHolds()
  console.log(`Expired ${count} hold(s).`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
