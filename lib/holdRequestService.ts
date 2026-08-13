import { prisma } from '@/lib/prisma'
import { sendHoldRequestEmail } from '@/lib/email'
import { appendHoldRequestToSheet } from '@/lib/googleSheets'
import type { ClientSession } from '@/lib/clientAuth'

export interface CreateHoldRequestParams {
  truck_number: string
  market?:      string | null
  state?:       string | null
  start_date:   string // yyyy-MM-dd
  end_date:     string // yyyy-MM-dd
  notes?:       string | null
}

/**
 * Single source of truth for creating a client's HoldRequest — always PENDING, always tagged
 * with the client's own client_user_id, never auto-approved. Used by both the manual
 * drag-on-the-grid submission (app/api/client/hold-requests/route.ts) and the AI assistant's
 * action-block execution (app/api/client/chat/route.ts), so the side effects (Firefly sheet
 * export, email notification) can't drift between the two entry points.
 */
export async function createHoldRequestForClient(
  session: ClientSession,
  params: CreateHoldRequestParams
) {
  const { truck_number, market, state, start_date, end_date, notes } = params

  const holdRequest = await prisma.holdRequest.create({
    data: {
      client_user_id: session.id,
      truck_number,
      market:     market ?? '',
      state:      state  ?? null,
      start_date: new Date(start_date),
      end_date:   new Date(end_date),
      notes:      notes  ?? null,
      status:     'PENDING',
    },
  })

  // Append to Google Sheet — Firefly only (no-op if env vars not set)
  if (session.companyName === 'Firefly' && session.username === 'firefly') {
    appendHoldRequestToSheet({
      submittedAt: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      companyName: session.companyName,
      truckNumber: truck_number,
      market:      market ?? '',
      state:       state  ?? '',
      startDate:   start_date,
      endDate:     end_date,
      notes:       notes  ?? '',
      status:      'PENDING',
    }).catch((e) => console.error('[sheets] append failed:', e))
  }

  // Send email notification (no-op if SMTP not configured)
  await sendHoldRequestEmail({
    companyName: session.companyName,
    truckNumber: truck_number,
    market:      market ?? '',
    startDate:   start_date,
    endDate:     end_date,
    notes:       notes ?? undefined,
  }).catch((e) => console.error('[email] send failed:', e))

  return holdRequest
}
