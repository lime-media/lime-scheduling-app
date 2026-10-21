/**
 * Who an MCP call acts for (headers X-Acting-User-Id and X-Acting-User-Type,
 * set by the MCP server from the caller's token): a client, who gets the
 * client portal's rules and code (lib/clientQuote.ts, lib/clientBooking.ts,
 * lib/clientAvailability.ts), or a staff member, who gets the Quote page's
 * (lib/staffQuote.ts, lib/staffBooking.ts). Server only.
 */

import { prisma } from '@/lib/prisma'
import type { ClientSession } from '@/lib/clientAuth'
import type { StaffActor } from '@/lib/staffBooking'

export type McpParty =
  | { kind: 'client'; session: ClientSession }
  | { kind: 'staff'; actor: StaffActor & { id: string } }
  | { kind: 'error'; status: number; error: string }

export async function mcpParty(req: Request): Promise<McpParty> {
  const id = req.headers.get('x-acting-user-id')
  // No default: a missing type must never fall through to the staff rules.
  const type = req.headers.get('x-acting-user-type')
  if (!id) return { kind: 'error', status: 400, error: 'Missing X-Acting-User-Id header' }
  if (type === 'client_user') {
    const c = await prisma.clientUser.findUnique({ where: { id } })
    if (!c) return { kind: 'error', status: 404, error: 'Acting client user not found' }
    return {
      kind: 'client',
      session: { id: c.id, username: c.username, companyName: c.company_name, partnerId: c.partner_id ?? undefined, sfdcAccountId: c.sfdc_account_id ?? undefined },
    }
  }
  if (type !== 'app_user') return { kind: 'error', status: 400, error: 'X-Acting-User-Type must be "app_user" or "client_user"' }
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true } })
  if (!u) return { kind: 'error', status: 404, error: 'Acting user not found' }
  return { kind: 'staff', actor: { id: u.id, name: u.name, email: u.email } }
}

/** The campaign an MCP quote or booking asks about, with every field's type checked. */
export type McpCampaign = {
  market: string
  start_date: string
  end_date: string
  truck_count: number
  shadow_fencing?: boolean
  smart_directional?: boolean
  device_id?: boolean
  studies?: string[]
  days_per_week?: 5 | 6 | 7
  operating_hours?: number
}

const isCalendarDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && new Date(Date.parse(s + 'T00:00:00Z')).toISOString().slice(0, 10) === s

/**
 * The campaign from an MCP request body, or the 400 message. Types are checked
 * here (Number(true) is 1, a string "false" is truthy), so the engine never
 * sees a value the app's own forms couldn't send, and an out-of-range value
 * is a refusal the caller can act on, not a 500 from deep in the pricing.
 */
export function parseMcpCampaign(body: Record<string, unknown>): McpCampaign | { error: string } {
  const { market, start_date, end_date, truck_count, shadow_fencing, smart_directional, device_id, studies, days_per_week, operating_hours } = body
  if (typeof market !== 'string' || !market.trim() || typeof truck_count !== 'number' || !Number.isInteger(truck_count) || truck_count < 1) {
    return { error: 'market, start_date, end_date (YYYY-MM-DD) and truck_count (a whole number, at least 1) are required' }
  }
  if (!isCalendarDate(start_date) || !isCalendarDate(end_date) || end_date < start_date) {
    return { error: 'start_date and end_date must be real dates (YYYY-MM-DD), end on or after start' }
  }
  for (const [name, v] of [['shadow_fencing', shadow_fencing], ['smart_directional', smart_directional], ['device_id', device_id]] as const) {
    if (v !== undefined && typeof v !== 'boolean') return { error: `${name} must be true or false` }
  }
  if (studies !== undefined && (!Array.isArray(studies) || !studies.every(x => typeof x === 'string'))) {
    return { error: 'studies must be a list of study names' }
  }
  if (days_per_week !== undefined && days_per_week !== 5 && days_per_week !== 6 && days_per_week !== 7) {
    return { error: 'days_per_week must be 5, 6 or 7' }
  }
  if (operating_hours !== undefined && (typeof operating_hours !== 'number' || !Number.isInteger(operating_hours) || operating_hours < 8 || operating_hours > 12)) {
    return { error: 'operating_hours must be a whole number from 8 to 12' }
  }
  return {
    market: market.trim(), start_date, end_date, truck_count,
    shadow_fencing: shadow_fencing as boolean | undefined, smart_directional: smart_directional as boolean | undefined, device_id: device_id as boolean | undefined,
    studies: studies as string[] | undefined, days_per_week, operating_hours,
  }
}
