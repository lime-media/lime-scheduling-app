import { prisma } from '@/lib/prisma'
import { sfdcQuery, isSfdcConfigured } from '@/lib/salesforceClient'
import { SFDC_SERVICE_USER_EMAIL } from '@/lib/sfdcIntegration'

/**
 * Opportunity stage reconcile.
 *
 * Salesforce pushes holds to us but never tells us when an Opportunity closes —
 * the webhook payload carries trucks and dates, no stage. So a hold placed for a
 * deal that later closed just sat there reserving its truck until it expired.
 *
 * Rather than requiring a Salesforce-side change to the outbound message, this
 * pulls the stage for every Opportunity behind an active SFDC hold and settles it:
 *
 *   Closed Won  → COMMITTED. The deal is real, so the truck genuinely is booked.
 *                 COMMITTED is already immune to expireHolds() and hides the
 *                 expiration badge, so the booking stops looking tentative.
 *   Closed Lost → EXPIRED. Releases the truck everywhere while keeping the row
 *                 visible on the Holds page, same as any other expiry.
 *   Still open  → left alone.
 *
 * Run from the hourly sweep, BEFORE expireHolds(), so a won deal sitting past its
 * Hold Exp is committed rather than expired out from under itself.
 */

// SOQL has a query-length limit; 200 ids per IN clause stays well inside it.
const SOQL_ID_CHUNK = 200

// Statuses worth checking. EXPIRED holds are already released. COMMITTED is
// included so an Opportunity that flips from Closed Won to Closed Lost still
// gives the truck back.
const RECONCILABLE_STATUSES = ['HOLD', 'EXTENSION_REQUESTED', 'COMMITTED']

// Salesforce ids are 15- or 18-character alphanumerics. Anything else is not
// interpolated into SOQL.
const SFDC_ID = /^[a-zA-Z0-9]{15,18}$/

interface OpportunityStage {
  Id:        string
  StageName: string
  IsClosed:  boolean
  IsWon:     boolean
}

export interface SfdcReconcileSummary {
  checked:   number
  committed: number
  released:  number
}

/** Salesforce treats 15- and 18-char ids interchangeably; the API always returns 18. */
function normalizeId(id: string): string {
  return id.slice(0, 15)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function reconcileSfdcOpportunities(): Promise<SfdcReconcileSummary> {
  const summary: SfdcReconcileSummary = { checked: 0, committed: 0, released: 0 }

  if (!isSfdcConfigured()) {
    console.log('[sfdc-reconcile] SFDC credentials not configured — skipping')
    return summary
  }

  const holds = await prisma.hold.findMany({
    where: {
      source:              'SALESFORCE',
      status:              { in: RECONCILABLE_STATUSES },
      sfdc_opportunity_id: { not: null },
    },
  })
  if (holds.length === 0) return summary

  // Group holds by Opportunity — one Opportunity commonly covers several trucks.
  const byOpportunity = new Map<string, typeof holds>()
  for (const hold of holds) {
    const raw = hold.sfdc_opportunity_id as string
    if (!SFDC_ID.test(raw)) {
      console.warn(`[sfdc-reconcile] skipping hold ${hold.id} — malformed opportunity id ${JSON.stringify(raw)}`)
      continue
    }
    const key = normalizeId(raw)
    const group = byOpportunity.get(key)
    if (group) group.push(hold)
    else byOpportunity.set(key, [hold])
  }
  if (byOpportunity.size === 0) return summary

  // Query stages. A thrown error propagates to the caller and nothing is written —
  // "we couldn't ask Salesforce" must never be read as "the deal is closed".
  const ids = holds
    .map((h) => h.sfdc_opportunity_id as string)
    .filter((id) => SFDC_ID.test(id))
  const uniqueIds = Array.from(new Set(ids))

  const stages = new Map<string, OpportunityStage>()
  for (const batch of chunk(uniqueIds, SOQL_ID_CHUNK)) {
    const list = batch.map((id) => `'${id}'`).join(',')
    const rows = await sfdcQuery<OpportunityStage>(
      `SELECT Id, StageName, IsClosed, IsWon FROM Opportunity WHERE Id IN (${list})`
    )
    for (const row of rows) stages.set(normalizeId(row.Id), row)
  }

  summary.checked = byOpportunity.size

  const missing = byOpportunity.size - stages.size
  if (missing > 0) {
    // Deleted in Salesforce, or outside this integration user's visibility.
    // Left untouched on purpose — releasing a truck on an absent record would
    // turn a permissions problem into a double-booking.
    console.warn(`[sfdc-reconcile] ${missing} opportunit${missing === 1 ? 'y' : 'ies'} not returned by Salesforce — leaving those holds alone`)
  }

  const serviceUser = await prisma.user.findUnique({ where: { email: SFDC_SERVICE_USER_EMAIL } })

  for (const [key, group] of byOpportunity) {
    const stage = stages.get(key)
    if (!stage || !stage.IsClosed) continue

    const target = stage.IsWon ? 'COMMITTED' : 'EXPIRED'

    for (const hold of group) {
      if (hold.status === target) continue

      await prisma.auditLog.create({
        data: {
          action:       target === 'COMMITTED' ? 'UPDATE_HOLD' : 'EXPIRE_HOLD',
          truck_number: hold.truck_number,
          user_id:      serviceUser?.id ?? hold.created_by,
          hold_id:      hold.id,
          details:      JSON.stringify({
            reason:              'sfdc_opportunity_closed',
            sfdc_opportunity_id: hold.sfdc_opportunity_id,
            stage_name:          stage.StageName,
            is_won:              stage.IsWon,
            from_status:         hold.status,
            to_status:           target,
          }),
        },
      })

      await prisma.hold.update({ where: { id: hold.id }, data: { status: target } })

      if (target === 'COMMITTED') summary.committed++
      else summary.released++

      console.log(
        `[sfdc-reconcile] truck ${hold.truck_number} | "${hold.client_name}" — ` +
        `Opportunity ${stage.StageName} → ${target}`
      )
    }
  }

  return summary
}

/**
 * Stage for a single Opportunity, for the webhook's reactivation path.
 *
 * Returns null when the stage can't be established — not configured, malformed
 * id, record not visible, or the query failed. Callers must treat null as
 * "unknown", never as "open" or "closed".
 */
export async function getOpportunityStage(
  opportunityId: string
): Promise<{ isClosed: boolean; isWon: boolean; stageName: string } | null> {
  if (!isSfdcConfigured() || !SFDC_ID.test(opportunityId)) return null

  try {
    const rows = await sfdcQuery<OpportunityStage>(
      `SELECT Id, StageName, IsClosed, IsWon FROM Opportunity WHERE Id = '${opportunityId}' LIMIT 1`
    )
    const row = rows[0]
    if (!row) return null
    return { isClosed: row.IsClosed, isWon: row.IsWon, stageName: row.StageName }
  } catch (err) {
    console.error(`[sfdc-reconcile] stage lookup failed for ${opportunityId}:`, err)
    return null
  }
}
