/**
 * Who owns each reservation, for the Reservations page's Owner filter.
 *
 * A booking on a Salesforce opportunity belongs to the opportunity's owner:
 * that's the rep whose deal it is, whoever (or whatever) created the hold.
 * Salesforce pushes, client-portal bookings and syncs are created by service
 * users, so the creator would hide a rep's own deals. The opportunity owner is
 * matched to their app login by email; an owner with no login keeps their
 * Salesforce name. A booking with no opportunity, or any booking when
 * Salesforce can't be read, falls back to the user who created it.
 * Server only.
 */

import { prisma } from '@/lib/prisma'
import { isSfdcConfigured, sfdcQuery } from '@/lib/salesforceClient'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

const SFDC_ID = /^[a-zA-Z0-9]{15,18}$/
const BATCH = 200
const key = (id: string) => id.slice(0, 15)

/**
 * Opportunity owners already read, by opportunity (15-char id), for
 * OWNER_TTL_MS: the list is reloaded after every approve, cancel or edit, and
 * an owner rarely changes. Per server instance.
 */
type OppOwner = { ownerId: string; name: string | null; email: string | null }
const ownerCache = new Map<string, { owner: OppOwner | null; at: number }>()
const OWNER_TTL_MS = 15 * 60 * 1000

/**
 * How long the list waits on Salesforce for owners it hasn't cached. Past it
 * the page loads with the creator standing in for those, and the lookup
 * carries on in the background to fill the cache for the next load.
 */
export const OWNER_WAIT_MS = 4000

type OwnerRow = { id: string; created_by: string; created_by_name: string | null; sfdc_opportunity_id: string | null }

/** Reads the owners of these opportunities and caches them (a missing opportunity caches as null). */
async function fetchOwners(oppIds: string[]): Promise<void> {
  for (let i = 0; i < oppIds.length; i += BATCH) {
    const batch = oppIds.slice(i, i + BATCH)
    const rows = await sfdcQuery<{ Id: string; OwnerId: string; Owner: { Name: string; Email: string | null } | null }>(
      `SELECT Id, OwnerId, Owner.Name, Owner.Email FROM Opportunity WHERE Id IN (${batch.map(id => `'${id}'`).join(',')})`,
    )
    const at = Date.now()
    for (const id of batch) ownerCache.set(key(id), { owner: null, at })
    for (const o of rows) ownerCache.set(key(o.Id), { owner: { ownerId: o.OwnerId, name: o.Owner?.Name ?? null, email: o.Owner?.Email?.toLowerCase() ?? null }, at })
  }
}

export async function reservationOwners(holds: OwnerRow[]): Promise<Map<string, { owner_id: string; owner_name: string }>> {
  const byCreator = (h: OwnerRow) => ({ owner_id: h.created_by, owner_name: h.created_by_name || 'Unknown' })
  const out = new Map(holds.map(h => [h.id, byCreator(h)]))
  const oppIds = [...new Set(holds.map(h => h.sfdc_opportunity_id).filter((id): id is string => !!id && SFDC_ID.test(id)))]
  if (oppIds.length === 0 || !isSfdcConfigured()) return out
  try {
    const now = Date.now()
    const missing = oppIds.filter(id => { const hit = ownerCache.get(key(id)); return !hit || now - hit.at >= OWNER_TTL_MS })
    if (missing.length) {
      // Degrade, don't hang the page: past the wait, uncached owners fall back to the creator.
      const lookup = fetchOwners(missing)
      lookup.catch(err => console.error('[reservations] opportunity owners unavailable:', err))
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        lookup.then(() => false, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), OWNER_WAIT_MS) }),
      ])
      clearTimeout(timer)
      if (timedOut) console.warn(`[reservations] Salesforce owners took over ${OWNER_WAIT_MS}ms; creators stand in for ${missing.length} opportunities`)
    }
    const opps = oppIds.map(id => ownerCache.get(key(id))?.owner).filter((o): o is OppOwner => !!o)
    const emails = [...new Set(opps.map(o => o.email).filter((e): e is string => !!e))]
    const users = emails.length ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, name: true, email: true } }) : []
    const userByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]))
    for (const h of holds) {
      const o = h.sfdc_opportunity_id ? ownerCache.get(key(h.sfdc_opportunity_id))?.owner : undefined
      if (!o) continue
      // An app booking can be owned by the integration user (no Salesforce
      // user matched the rep or the account): the rep who booked it owns it here.
      if (o.email === SFDC_SERVICE_USER_EMAIL && !isServiceCreator(h, users)) continue
      const u = o.email ? userByEmail.get(o.email) : undefined
      out.set(h.id, u ? { owner_id: u.id, owner_name: u.name || o.name || 'Unknown' } : { owner_id: `sfdc:${o.ownerId}`, owner_name: o.name || 'Unknown' })
    }
  } catch (err) {
    // Degrade, don't fail the page: the creator stands in.
    console.error('[reservations] opportunity owners unavailable:', err)
  }
  return out
}

/**
 * The hold was created by the app's service user (a Salesforce push or sync),
 * so the creator isn't a rep either. `users` holds the app users matched to
 * owner emails, which includes the service user whenever it owns one.
 */
function isServiceCreator(h: OwnerRow, users: { id: string; email: string }[]): boolean {
  return users.some(u => u.id === h.created_by && u.email.toLowerCase() === SFDC_SERVICE_USER_EMAIL)
}
