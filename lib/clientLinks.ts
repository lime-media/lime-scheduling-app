/**
 * A client's Salesforce Account and rate-agreement link, read from the row
 * rather than from their session.
 *
 * The session carries copies signed at login, and a session now lasts 30 days
 * (lib/clientAuth.ts). Pricing a hold off those copies means an ops correction
 * — relinking an account, moving a rate agreement — would not reach a client
 * who stays signed in, so they could keep booking at the old rates or under
 * the wrong Salesforce Account until their session ran out. Anything that
 * prices work or writes to Salesforce reads the live values through here.
 *
 * Identity (who they are) still comes from the signed session; this is only
 * the links, which ops changes without the client doing anything.
 */

import { prisma } from '@/lib/prisma'
import type { ClientSession } from '@/lib/clientAuth'

export type ClientLinks = { partnerId?: string; sfdcAccountId?: string }

/**
 * The client's current links. An account ops has since deleted, or a read
 * that comes back empty, gives no links — standard rate card, no Salesforce
 * — which is the same as a client who never had either.
 */
export async function liveClientLinks(session: ClientSession): Promise<ClientLinks> {
  const row = await prisma.clientUser.findUnique({
    where:  { id: session.id },
    select: { partner_id: true, sfdc_account_id: true },
  })
  return {
    partnerId:     row?.partner_id ?? undefined,
    sfdcAccountId: row?.sfdc_account_id ?? undefined,
  }
}
