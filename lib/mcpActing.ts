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
  const type = req.headers.get('x-acting-user-type') || 'app_user'
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
