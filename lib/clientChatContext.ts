import { prisma } from '@/lib/prisma'
import { centralDate } from '@/lib/dateOnly'
import { activeHoldWhere } from '@/lib/holdFilters'
import type { ClientSession } from '@/lib/clientAuth'

const toDateStr = (d: Date) => d.toISOString().split('T')[0]

export interface ClientChatContext {
  prompt: string
}

/**
 * Builds the AI context for ONE client's chat session: today's date and the
 * client's own live holds, in full (their own data).
 *
 * SAFETY — this is the only fact the client chat route puts in the prompt, and
 * it holds nothing about any other client or the fleet. Availability comes
 * from the check_availability tool (lib/clientAvailability.ts), which answers
 * yes or no for the client's own request and never names trucks, other
 * bookings or who made them. If this function is ever extended, run every new
 * field through: "could this name, or let someone infer, another client?"
 * before adding it.
 */
export async function buildClientChatContext(session: ClientSession): Promise<ClientChatContext> {
  // The app's day is Central (REVIEW.md); after 7pm Central, UTC's date is already tomorrow.
  const today = centralDate(new Date())

  // Released holds (status EXPIRED, or expires_at already passed) are not live.
  const myRequests = await prisma.hold.findMany({
    where: { client_user_id: session.id, ...activeHoldWhere() },
    orderBy: { start_date: 'asc' },
  })

  const myRequestLines = myRequests.map((r) => {
    const where = [r.market, r.state].filter(Boolean).join(', ')
    return `- Truck ${r.truck_number}: ${r.status} in ${where} (${toDateStr(r.start_date)} → ${toDateStr(r.end_date)})${r.notes ? ' — notes: ' + r.notes : ''}`
  })

  const prompt = `Today's date: ${today}.

${session.companyName.toUpperCase()}'S OWN HOLD REQUESTS (${myRequests.length} total) — the only client whose hold-request details you may ever discuss:
${myRequestLines.join('\n') || 'No hold requests on file.'}`

  return { prompt }
}
