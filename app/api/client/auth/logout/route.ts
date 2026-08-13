import { NextResponse } from 'next/server'
import { clearClientSession } from '@/lib/clientAuth'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  clearClientSession(res)
  return res
}
