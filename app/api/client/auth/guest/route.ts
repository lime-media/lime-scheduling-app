import { NextResponse } from 'next/server'
import { setGuestSession } from '@/lib/clientAuth'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  setGuestSession(res)
  return res
}
