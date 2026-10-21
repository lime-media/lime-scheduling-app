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

const SFDC_ID = /^[a-zA-Z0-9]{15,18}$/
const BATCH = 200
const key = (id: string) => id.slice(0, 15)

type OwnerRow = { id: string; created_by: string; created_by_name: string | null; sfdc_opportunity_id: string | null }

export async function reservationOwners(holds: OwnerRow[]): Promise<Map<string, { owner_id: string; owner_name: string }>> {
  const byCreator = (h: OwnerRow) => ({ owner_id: h.created_by, owner_name: h.created_by_name || 'Unknown' })
  const out = new Map(holds.map(h => [h.id, byCreator(h)]))
  const oppIds = [...new Set(holds.map(h => h.sfdc_opportunity_id).filter((id): id is string => !!id && SFDC_ID.test(id)))]
  if (oppIds.length === 0 || !isSfdcConfigured()) return out
  try {
    const opps: { Id: string; OwnerId: string; Owner: { Name: string; Email: string | null } | null }[] = []
    for (let i = 0; i < oppIds.length; i += BATCH) {
      opps.push(...await sfdcQuery<typeof opps[number]>(
        `SELECT Id, OwnerId, Owner.Name, Owner.Email FROM Opportunity WHERE Id IN (${oppIds.slice(i, i + BATCH).map(id => `'${id}'`).join(',')})`,
      ))
    }
    const emails = [...new Set(opps.map(o => o.Owner?.Email?.toLowerCase()).filter((e): e is string => !!e))]
    const users = emails.length ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, name: true, email: true } }) : []
    const userByEmail = new Map(users.map(u => [u.email.toLowerCase(), u]))
    const ownerByOpp = new Map(opps.map(o => {
      const u = o.Owner?.Email ? userByEmail.get(o.Owner.Email.toLowerCase()) : undefined
      return [key(o.Id), u ? { owner_id: u.id, owner_name: u.name || o.Owner?.Name || 'Unknown' } : { owner_id: `sfdc:${o.OwnerId}`, owner_name: o.Owner?.Name || 'Unknown' }]
    }))
    for (const h of holds) {
      const owner = h.sfdc_opportunity_id ? ownerByOpp.get(key(h.sfdc_opportunity_id)) : undefined
      if (owner) out.set(h.id, owner)
    }
  } catch (err) {
    // Degrade, don't fail the page: the creator stands in.
    console.error('[reservations] opportunity owners unavailable:', err)
  }
  return out
}
