'use client'

/**
 * Tells the server someone is using the app, for "Last activity" on the Users
 * page: on page loads and navigation, at most once every 10 minutes per tab.
 * Staff pages ping /api/activity, the client portal /api/client/activity;
 * login pages never ping. Fire-and-forget: a failure is ignored.
 */

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

const EVERY_MS = 10 * 60_000

export function ActivityPing() {
  const pathname = usePathname() ?? ''
  useEffect(() => {
    if (pathname.endsWith('/login')) return
    const client = pathname.startsWith('/client')
    const key = client ? 'activity.client' : 'activity.staff'
    try {
      const last = Number(sessionStorage.getItem(key) ?? 0)
      if (Date.now() - last < EVERY_MS) return
      sessionStorage.setItem(key, String(Date.now()))
    } catch { /* storage blocked: ping anyway */ }
    fetch(client ? '/api/client/activity' : '/api/activity', { method: 'POST', keepalive: true }).catch(() => {})
  }, [pathname])
  return null
}
