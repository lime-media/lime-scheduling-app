import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { isSfdcConfigured, sfdcQuery } from '@/lib/salesforceClient'
import { isLinkableAccount, ledClients, suggestLedClient } from '@/lib/ledClients'

// Only an isLinkableAccount id reaches SOQL.
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The account's name in Salesforce, or null if it can't be read. */
async function accountName(id: string): Promise<string | null> {
  if (!isSfdcConfigured()) return null
  try {
    const rows = await sfdcQuery<{ Name: string }>(`SELECT Name FROM Account WHERE Id = '${id}'`)
    return rows[0]?.Name ?? null
  } catch (err) {
    console.error('[led-clients] account name read failed:', err)
    return null
  }
}

/**
 * Keep a link's stored account name current: it's saved blank when Salesforce
 * can't be read at link time, and accounts get renamed. Best-effort.
 */
async function refreshAccountName(account: string, stored: string | undefined, name: string | null) {
  const label = name?.slice(0, 255)
  if (stored === undefined || !label || label === stored) return
  await prisma.ledClientLink.update({ where: { sfdc_account_id: account }, data: { account_name: label } })
    .catch((err) => console.error('[led-clients] account name refresh failed:', err))
}

/**
 * GET /api/led-clients?account=<Salesforce AccountId>
 *
 * Staff only. The LED clients to pick from, the account's current link, and a
 * suggestion from the names (lib/ledClients.ts).
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const account = new URL(request.url).searchParams.get('account') ?? ''
  if (!isLinkableAccount(account)) return NextResponse.json({ error: 'account must be a Salesforce Account id' }, { status: 400 })

  const [clients, link, name] = await Promise.all([
    ledClients().catch((err) => { console.error('[led-clients] LED client read failed:', err); return null }),
    prisma.ledClientLink.findUnique({ where: { sfdc_account_id: account } }),
    accountName(account),
  ])
  if (!clients) return NextResponse.json({ error: "The LED client list couldn't be read. Try again shortly." }, { status: 502 })

  await refreshAccountName(account, link?.account_name, name)
  const linked = link ? clients.find(c => c.client_uid === link.client_uid.toLowerCase()) ?? null : null
  const accountLabel = name ?? (link?.account_name || null)
  return NextResponse.json({
    account_name: accountLabel,
    clients,
    // A link to an LED client since deleted in LED shows as unlinked, and says so.
    link: linked,
    link_deleted: !!link && !linked,
    suggestion: linked || !accountLabel ? null : suggestLedClient(accountLabel, clients),
  })
}

/**
 * PUT /api/led-clients  { sfdc_account_id, client_uid }
 *
 * Staff only. Links the account to a live LED client (replacing any earlier
 * link), recorded in the audit log.
 */
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null) as { sfdc_account_id?: unknown; client_uid?: unknown } | null
  const account = typeof body?.sfdc_account_id === 'string' ? body.sfdc_account_id : ''
  const clientUid = typeof body?.client_uid === 'string' ? body.client_uid.toLowerCase() : ''
  if (!isLinkableAccount(account)) return NextResponse.json({ error: 'sfdc_account_id must be a Salesforce Account id' }, { status: 400 })
  if (!UID.test(clientUid)) return NextResponse.json({ error: 'client_uid must be an LED client id' }, { status: 400 })

  const [clients, name, earlier] = await Promise.all([
    ledClients().catch((err) => { console.error('[led-clients] LED client read failed:', err); return null }),
    accountName(account),
    prisma.ledClientLink.findUnique({ where: { sfdc_account_id: account } }),
  ])
  if (!clients) return NextResponse.json({ error: "The LED client list couldn't be read, so the link wasn't saved. Try again shortly." }, { status: 502 })
  const client = clients.find(c => c.client_uid === clientUid)
  if (!client) return NextResponse.json({ error: 'That LED client no longer exists.' }, { status: 404 })
  // Already linked to it: nothing to save or audit.
  if (earlier?.client_uid.toLowerCase() === clientUid) {
    await refreshAccountName(account, earlier.account_name, name)
    return NextResponse.json({ link: client })
  }

  const accountLabel = (name ?? earlier?.account_name ?? '').slice(0, 255)
  await prisma.$transaction([
    prisma.ledClientLink.upsert({
      where: { sfdc_account_id: account },
      create: { sfdc_account_id: account, account_name: accountLabel, client_uid: clientUid, linked_by: session.user.id },
      update: { account_name: accountLabel, client_uid: clientUid, linked_by: session.user.id, linked_at: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        action: 'LINK_LED_CLIENT',
        // Account-level: no hold and no truck. The column is required, so blank.
        truck_number: '',
        user_id: session.user.id,
        details: JSON.stringify({ sfdc_account_id: account, account_name: accountLabel, client_uid: clientUid, client: client.client, previous_client_uid: earlier?.client_uid ?? null }),
      },
    }),
  ])
  return NextResponse.json({ link: client })
}
