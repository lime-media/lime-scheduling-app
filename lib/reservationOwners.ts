/**
 * Who owns each reservation, for the Reservations page's Owner filter, and
 * its Salesforce opportunity's name and whether it's still open, read in the
 * same query so the card's name follows Salesforce (a rename there shows
 * within OWNER_TTL_MS; a rename in the app updates the cache at once,
 * rememberOpportunityName).
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

import { waitUntil } from '@vercel/functions'
import { prisma } from '@/lib/prisma'
import { isSfdcConfigured, sfdcQuery } from '@/lib/salesforceClient'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

const SFDC_ID = /^[a-zA-Z0-9]{15,18}$/
const BATCH = 200
const key = (id: string) => id.slice(0, 15)

/**
 * Opportunities already read, by opportunity (15-char id), for OWNER_TTL_MS:
 * the list is reloaded after every approve, cancel or edit, and an owner or
 * name rarely changes. Per server instance.
 */
type OppOwner = { ownerId: string; name: string | null; email: string | null; oppName: string | null; closed: boolean }
const ownerCache = new Map<string, { owner: OppOwner | null; at: number }>()
const OWNER_TTL_MS = 5 * 60 * 1000
/** Opportunities a lookup is already reading, so concurrent loads share it instead of re-querying. */
const inflight = new Map<string, Promise<void>>()

/**
 * How long the list waits on Salesforce for owners it hasn't cached. Past it
 * the page loads with the creator standing in for those, and the lookup
 * carries on in the background to fill the cache for the next load.
 */
export const OWNER_WAIT_MS = 4000

type OwnerRow = { id: string; created_by: string; created_by_name: string | null; sfdc_opportunity_id: string | null }

/**
 * Renames made in the app, by opportunity (15-char id), with when: a lookup
 * that queried Salesforce before the rename landed keeps the new name instead
 * of caching the old one for OWNER_TTL_MS.
 */
const renamed = new Map<string, { name: string; at: number }>()

/** Reads the owners of these opportunities and caches them (a missing opportunity caches as null). */
async function fetchOwners(oppIds: string[]): Promise<void> {
  for (let i = 0; i < oppIds.length; i += BATCH) {
    const batch = oppIds.slice(i, i + BATCH)
    const queriedAt = Date.now()
    const rows = await sfdcQuery<{ Id: string; Name: string | null; IsClosed: boolean; OwnerId: string; Owner: { Name: string; Email: string | null } | null }>(
      `SELECT Id, Name, IsClosed, OwnerId, Owner.Name, Owner.Email FROM Opportunity WHERE Id IN (${batch.map(id => `'${id}'`).join(',')})`,
    )
    const at = Date.now()
    for (const [k, v] of ownerCache) if (at - v.at >= OWNER_TTL_MS) ownerCache.delete(k)
    for (const [k, v] of renamed) if (at - v.at >= OWNER_TTL_MS) renamed.delete(k)
    for (const id of batch) ownerCache.set(key(id), { owner: null, at })
    for (const o of rows) {
      const r = renamed.get(key(o.Id))
      const oppName = r && r.at >= queriedAt ? r.name : o.Name ?? null
      ownerCache.set(key(o.Id), { owner: { ownerId: o.OwnerId, name: o.Owner?.Name ?? null, email: o.Owner?.Email?.toLowerCase() ?? null, oppName, closed: o.IsClosed === true }, at })
    }
  }
}

/**
 * A rename made in the app (app/api/opportunities/[id]/name/route.ts): the
 * cached opportunity takes the new name at once, so this instance's next list
 * shows it without waiting for OWNER_TTL_MS. Other instances catch up on their
 * next read.
 */
export function rememberOpportunityName(opportunityId: string, name: string): void {
  renamed.set(key(opportunityId), { name, at: Date.now() })
  const hit = ownerCache.get(key(opportunityId))
  if (hit?.owner) hit.owner = { ...hit.owner, oppName: name }
}

export type ReservationOwner = {
  owner_id: string
  owner_name: string
  /**
   * No person owns it: it fell back to a creator that is the Salesforce
   * service user (client-portal requests, or a push whose opportunity owner
   * couldn't be read). The page lists these under every seller's "Me", so a
   * client request is never out of everyone's default view.
   */
  owner_unassigned: boolean
  /** The opportunity's name in Salesforce; null when it has none, or Salesforce couldn't be read in time. */
  opportunity_name: string | null
  /** Closed (won or lost) in Salesforce; null when not known. */
  opportunity_closed: boolean | null
}

export async function reservationOwners(holds: OwnerRow[]): Promise<Map<string, ReservationOwner>> {
  const out = await ownersOf(holds)
  let serviceUserId: string | null = null
  try {
    serviceUserId = (await prisma.user.findFirst({ where: { email: SFDC_SERVICE_USER_EMAIL }, select: { id: true } }))?.id ?? null
  } catch (err) {
    console.error('[reservations] service user lookup failed:', err)
  }
  return new Map([...out].map(([id, o]) => [id, { ...o, owner_unassigned: !!serviceUserId && o.owner_id === serviceUserId }]))
}

type Owned = Omit<ReservationOwner, 'owner_unassigned'>

async function ownersOf(holds: OwnerRow[]): Promise<Map<string, Owned>> {
  const byCreator = (h: OwnerRow): Owned => ({ owner_id: h.created_by, owner_name: h.created_by_name || 'Unknown', opportunity_name: null, opportunity_closed: null })
  const out = new Map(holds.map(h => [h.id, byCreator(h)]))
  const oppIds = [...new Set(holds.map(h => h.sfdc_opportunity_id).filter((id): id is string => !!id && SFDC_ID.test(id)))]
  if (oppIds.length === 0 || !isSfdcConfigured()) return out
  try {
    const now = Date.now()
    const stale = oppIds.filter(id => { const hit = ownerCache.get(key(id)); return !hit || now - hit.at >= OWNER_TTL_MS })
    if (stale.length) {
      // Degrade, don't hang the page: past the wait, uncached owners fall back to the creator.
      const toFetch = stale.filter(id => !inflight.has(key(id)))
      if (toFetch.length) {
        const started = fetchOwners(toFetch)
          .catch(err => console.error('[reservations] opportunity owners unavailable:', err))
          .finally(() => { for (const id of toFetch) if (inflight.get(key(id)) === started) inflight.delete(key(id)) })
        for (const id of toFetch) inflight.set(key(id), started)
        // Keep the function alive after the response so the lookup still fills the cache.
        waitUntil(started)
      }
      const lookup = Promise.all([...new Set(stale.map(id => inflight.get(key(id))).filter((p): p is Promise<void> => !!p))])
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        lookup.then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), OWNER_WAIT_MS) }),
      ])
      clearTimeout(timer)
      if (timedOut) {
        const still = stale.filter(id => { const hit = ownerCache.get(key(id)); return !hit || Date.now() - hit.at >= OWNER_TTL_MS }).length
        console.warn(`[reservations] Salesforce owners took over ${OWNER_WAIT_MS}ms; creators stand in for ${still} opportunities`)
      }
    }
    const opps = oppIds.map(id => ownerCache.get(key(id))?.owner).filter((o): o is OppOwner => !!o)
    const emails = [...new Set(opps.map(o => o.email).filter((e): e is string => !!e))]
    const users = emails.length ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, name: true, email: true } }) : []
    const userByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]))
    for (const h of holds) {
      const o = h.sfdc_opportunity_id ? ownerCache.get(key(h.sfdc_opportunity_id))?.owner : undefined
      if (!o) continue
      const u = o.email ? userByEmail.get(o.email) : undefined
      const opp = { opportunity_name: o.oppName, opportunity_closed: o.closed }
      out.set(h.id, u ? { owner_id: u.id, owner_name: u.name || o.name || 'Unknown', ...opp } : { owner_id: `sfdc:${o.ownerId}`, owner_name: o.name || 'Unknown', ...opp })
    }
  } catch (err) {
    // Degrade, don't fail the page: the creator stands in.
    console.error('[reservations] opportunity owners unavailable:', err)
  }
  return out
}

