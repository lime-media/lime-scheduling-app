import cron from 'node-cron'
import { refreshCache } from '@/lib/scheduleCache'

let started = false

/**
 * Start all background cron jobs. Safe to call multiple times — only starts once.
 * Called from app/layout.tsx on server boot (both dev and prod).
 */
export function startCronJobs(): void {
  if (started) return
  started = true

  console.log('[cron] scheduler started - refreshing every hour')

  // Run immediately on startup so conflicts are detected before the first UI load
  refreshCache().catch((err) => console.error('[cron] startup refresh failed:', err))

  cron.schedule('0 * * * *', () => {
    refreshCache().catch((err) => console.error('[cron] refresh failed:', err))
  })
}
