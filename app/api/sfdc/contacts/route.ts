import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { isSfdcConfigured } from '@/lib/salesforceClient'
import { isAccountId, searchContacts } from '@/lib/sfdcSearch'

/**
 * GET /api/sfdc/contacts?accountId=001…&q=search_term
 *
 * The chosen account's Salesforce Contacts, for picking an opportunity's
 * primary contact on the quote and planner pages. Without `q`, the account's
 * contacts by name (some agencies have close to a hundred); with it, those
 * whose name or email contains it. Staff only.
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isSfdcConfigured()) return NextResponse.json({ error: 'Salesforce not configured' }, { status: 503 })

  const accountId = req.nextUrl.searchParams.get('accountId')?.trim() ?? ''
  if (!isAccountId(accountId)) {
    return NextResponse.json({ error: 'accountId must be a Salesforce Account id' }, { status: 400 })
  }
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  try {
    return NextResponse.json({ contacts: await searchContacts(accountId, q) })
  } catch (err) {
    console.error('[sfdc/contacts] search failed:', err)
    return NextResponse.json({ error: 'Contact search failed' }, { status: 500 })
  }
}
