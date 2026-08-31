import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { sfdcQuery, isSfdcConfigured } from '@/lib/salesforceClient'

/**
 * GET /api/sfdc/accounts?q=search_term
 *
 * Search Salesforce Accounts by name. Used by the internal quote page
 * to let staff pick a client before quoting.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!isSfdcConfigured()) {
    return NextResponse.json({ error: 'Salesforce not configured' }, { status: 503 })
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ accounts: [] })
  }

  try {
    const escaped = q.replace(/'/g, "\\'")
    const records = await sfdcQuery<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM Account WHERE Name LIKE '%${escaped}%' ORDER BY Name LIMIT 20`
    )
    return NextResponse.json({
      accounts: records.map(r => ({ id: r.Id, name: r.Name })),
    })
  } catch (err) {
    console.error('[sfdc/accounts] search failed:', err)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
