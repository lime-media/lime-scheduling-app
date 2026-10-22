import { NextRequest, NextResponse } from 'next/server'
import { isSfdcConfigured } from '@/lib/salesforceClient'
import { searchAccounts } from '@/lib/sfdcSearch'
import { getToken } from 'next-auth/jwt'

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
  try {
    return NextResponse.json({ accounts: await searchAccounts(q) })
  } catch (err) {
    console.error('[sfdc/accounts] search failed:', err)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
