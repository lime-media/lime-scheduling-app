'use client'

import { useEffect, useState } from 'react'

export type ClientUser = {
  id: string
  username: string
  companyName: string
}

// Staged rollout — mirrors the server-side gate in app/api/client/chat/route.ts (POST returns 403
// for anyone but testclient). That route check is the real security boundary; this one exists so
// the nav link and /client/ai page don't advertise a feature every other client would just hit a
// 403 on — remove both gates together once the assistant opens up beyond testclient.
export function hasAiAssistantAccess(user: ClientUser | null): boolean {
  return user?.username === 'testclient'
}

/** Shared client-portal auth check — used by every /client/* page so they never drift out of sync. */
export function useClientAuth() {
  const [clientUser, setClientUser] = useState<ClientUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  useEffect(() => {
    fetch('/api/client/auth/me')
      .then((r) => r.json())
      .then((d) => setClientUser(d.user ?? null))
      .catch(() => {})
      .finally(() => setAuthChecked(true))
  }, [])

  return { clientUser, authChecked }
}
