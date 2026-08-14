'use client'

import { useEffect, useState } from 'react'

export type ClientUser = {
  id: string
  username: string
  companyName: string
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
