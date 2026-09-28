/**
 * GET /api/sfdc/user-matches — for every internal app user, the active
 * Salesforce User with the same email: who their opportunities will be
 * owned by. Staff only. `null` means no Salesforce user matches, so their
 * opportunities fall back to the account owner.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { prisma } from '@/lib/prisma'
import { isSfdcConfigured, sfdcQuery } from '@/lib/salesforceClient'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isSfdcConfigured()) return NextResponse.json({ configured: false, matches: {} })

  const users = await prisma.user.findMany({ select: { email: true } })
  const emails = [...new Set(users.map(u => u.email.trim().toLowerCase()).filter(e => /^[^\s'@]+@[^\s'@]+$/.test(e)))]
  const matches: Record<string, { id: string; name: string } | null> = Object.fromEntries(emails.map(e => [e, null]))
  try {
    for (let i = 0; i < emails.length; i += 100) {
      const chunk = emails.slice(i, i + 100)
      const rows = await sfdcQuery<{ Id: string; Name: string; Email: string }>(
        `SELECT Id, Name, Email FROM User WHERE IsActive = true AND UserType = 'Standard' AND Email IN (${chunk.map(e => `'${e}'`).join(',')})`,
      )
      for (const r of rows) {
        const e = r.Email.toLowerCase()
        if (e in matches && !matches[e]) matches[e] = { id: r.Id, name: r.Name }
      }
    }
  } catch (err) {
    console.error('[sfdc/user-matches] failed:', err)
    return NextResponse.json({ error: 'Salesforce lookup failed' }, { status: 502 })
  }
  return NextResponse.json({ configured: true, matches })
}
