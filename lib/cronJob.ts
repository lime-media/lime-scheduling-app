import cron from 'node-cron'
import { refreshCache } from '@/lib/scheduleCache'

const g = global as typeof globalThis & { __cronStarted?: boolean }

export function startCronJobs(): void {
  if (g.__cronStarted) return
  g.__cronStarted = true

  console.log('[cron] scheduler started - refreshing every hour')

  // Run immediately on startup so conflicts are detected before the first UI load
  refreshCache().catch((err) => console.error('[cron] startup refresh failed:', err))

  cron.schedule('0 * * * *', () => {
    refreshCache().catch((err) => console.error('[cron] refresh failed:', err))
  })
}
