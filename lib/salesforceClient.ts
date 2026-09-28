/**
 * Salesforce REST API client using Client Credentials OAuth flow.
 *
 * Used for outbound integration: creating/updating Opportunities when
 * holds are placed from the client portal.
 */

const SFDC_CLIENT_ID     = process.env.SFDC_CLIENT_ID ?? ''
const SFDC_CLIENT_SECRET = process.env.SFDC_CLIENT_SECRET ?? ''
const SFDC_LOGIN_URL     = (process.env.SFDC_LOGIN_URL ?? 'https://login.salesforce.com').replace(/\/+$/, '')
const API_VERSION        = 'v61.0'

// ---------------------------------------------------------------------------
// Auth — cached token with expiry
// ---------------------------------------------------------------------------

let cachedToken: { accessToken: string; instanceUrl: string; expiresAt: number } | null = null

async function getAccessToken(): Promise<{ accessToken: string; instanceUrl: string }> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return { accessToken: cachedToken.accessToken, instanceUrl: cachedToken.instanceUrl }
  }

  if (!SFDC_CLIENT_ID || !SFDC_CLIENT_SECRET) {
    throw new Error('SFDC_CLIENT_ID and SFDC_CLIENT_SECRET must be set')
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SFDC_CLIENT_ID,
    client_secret: SFDC_CLIENT_SECRET,
  })

  const res = await fetch(`${SFDC_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    cache: 'no-store',
  })

  const data = await res.json()
  if (!data.access_token) {
    throw new Error(`Salesforce auth failed: ${data.error_description || data.error || 'unknown error'}`)
  }

  // Cache for 1 hour (Salesforce tokens typically last 2 hours)
  cachedToken = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
    expiresAt: Date.now() + 60 * 60 * 1000,
  }

  return { accessToken: cachedToken.accessToken, instanceUrl: cachedToken.instanceUrl }
}

// ---------------------------------------------------------------------------
// Generic REST helpers
// ---------------------------------------------------------------------------

async function sfdcFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { accessToken, instanceUrl } = await getAccessToken()
  const url = `${instanceUrl}/services/data/${API_VERSION}${path}`
  return fetch(url, {
    ...options,
    // Next patches fetch and will put GET responses in the Data Cache — the first
    // production sweep logged "Updating Data Cache" against every SOQL query. A
    // cached stage read is actively wrong here: getOpportunityStage() issues the
    // same URL for the same Opportunity every hour, so the reconcile would decide
    // Closed Won/Lost from a stale snapshot, and the webhook's revival check would
    // gate on one too. Salesforce is authoritative and must be read live.
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
}

// ---------------------------------------------------------------------------
// Opportunity operations
// ---------------------------------------------------------------------------

export type CreateOpportunityInput = {
  accountId: string
  name: string
  stageName: string
  closeDate: string           // YYYY-MM-DD
  amount?: number
  market?: string
  holdStart?: string          // YYYY-MM-DD
  holdStop?: string           // YYYY-MM-DD
  holdExp?: string            // YYYY-MM-DD
  truckNumbers?: string[]     // e.g. ['0044', '0751']
  ledRevenue?: number
  /** Activation_Notes__c holds 500 characters; longer text is cut. */
  activationNotes?: string
  /** Opportunity Description (32,000 characters). */
  description?: string
  /** Salesforce User who owns the opportunity; omitted = the integration user. */
  ownerId?: string
  /** Opportunity Client Type (Agency / Brand Direct). */
  clientType?: 'Agency' | 'Brand Direct'
}

export type SfdcOpportunityResult = {
  success: boolean
  id?: string
  errors?: unknown[]
}

/**
 * Create a new Opportunity in Salesforce.
 */
export async function createOpportunity(input: CreateOpportunityInput): Promise<SfdcOpportunityResult> {
  const body: Record<string, unknown> = {
    AccountId: input.accountId,
    Name: input.name,
    StageName: input.stageName,
    CloseDate: input.closeDate,
    Asset_Type__c: 'LED',
    Job_Type__c: 'LED',
  }

  if (input.amount != null) body.Amount = input.amount
  if (input.market) body.Markets__c = input.market
  if (input.ownerId) body.OwnerId = input.ownerId
  if (input.clientType) body.Client_Type__c = input.clientType
  if (input.holdStart) body.LED_Hold_Start__c = input.holdStart
  if (input.holdStop) body.LED_Hold_Stop__c = input.holdStop
  if (input.holdExp) body.LED_Hold_Exp__c = input.holdExp
  if (input.truckNumbers && input.truckNumbers.length > 0) {
    body.LED_Trucks__c = input.truckNumbers.map(t => `LED-${t}`).join(';')
  }
  if (input.activationNotes) body.Activation_Notes__c = input.activationNotes.length > 500 ? input.activationNotes.slice(0, 497) + '...' : input.activationNotes
  if (input.description) body.Description = input.description.slice(0, 32000)
  // LED_Revenue__c is a read-only field (formula/rollup) — use Amount instead

  const res = await sfdcFetch('/sobjects/Opportunity', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  const data = await res.json()
  if (!data.success) {
    console.error('[sfdc] Opportunity creation failed. Status:', res.status, 'Response:', JSON.stringify(data))
  }
  return {
    success: data.success ?? false,
    id: data.id,
    errors: data.errors,
  }
}

/**
 * Update an existing Opportunity in Salesforce.
 */
export async function updateOpportunity(
  opportunityId: string,
  fields: Partial<Record<string, unknown>>,
): Promise<boolean> {
  const res = await sfdcFetch(`/sobjects/Opportunity/${opportunityId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  })

  // SFDC returns 204 No Content on success
  if (res.status === 204) return true

  // Log why. The common failure is an invalid picklist value (StageName), which
  // is otherwise indistinguishable from any other rejection at the call site.
  const body = await res.json().catch(() => null)
  const detail = Array.isArray(body) && body[0]?.message
    ? `${body[0].errorCode}: ${body[0].message}`
    : `HTTP ${res.status}`
  console.error(`[sfdc] Opportunity ${opportunityId} update failed — ${detail}`, fields)
  return false
}

/**
 * Query Salesforce using SOQL.
 *
 * Throws on a non-2xx response rather than returning an empty array. A failed
 * query and a query with genuinely no matches used to be indistinguishable,
 * which is dangerous for any caller that treats "not returned" as a fact about
 * the record — the Opportunity stage reconcile in lib/sfdcOpportunityReconcile.ts
 * would read an auth failure as "no open Opportunities" if this stayed silent.
 */
export async function sfdcQuery<T = Record<string, unknown>>(soql: string): Promise<T[]> {
  const res = await sfdcFetch(`/query?q=${encodeURIComponent(soql)}`)
  const data = await res.json().catch(() => null)

  if (!res.ok) {
    // Salesforce returns errors as [{ message, errorCode }]
    const detail = Array.isArray(data) && data[0]?.message
      ? `${data[0].errorCode}: ${data[0].message}`
      : `HTTP ${res.status}`
    throw new Error(`Salesforce SOQL query failed — ${detail}`)
  }

  return data?.records ?? []
}

/**
 * Check if SFDC credentials are configured.
 */
export function isSfdcConfigured(): boolean {
  return Boolean(SFDC_CLIENT_ID && SFDC_CLIENT_SECRET)
}

// ---------------------------------------------------------------------------
// Owners and client type
// ---------------------------------------------------------------------------

export { soqlString, SAFE_EMAIL } from './soql'
import { SAFE_EMAIL } from './soql'

const ownerCache = new Map<string, { id: string | null; at: number }>()
const OWNER_TTL_MS = 60 * 60 * 1000

/**
 * The active, standard Salesforce User with this email — how an internal app
 * user is tied to their Salesforce user, so opportunities they create are
 * owned by them rather than by the integration user. Null when none matches.
 */
export async function findSfdcUserIdByEmail(email: string | null | undefined): Promise<string | null> {
  const e = (email ?? '').trim().toLowerCase()
  if (!e || !SAFE_EMAIL.test(e)) return null
  const hit = ownerCache.get(e)
  if (hit && Date.now() - hit.at < OWNER_TTL_MS) return hit.id
  const rows = await sfdcQuery<{ Id: string }>(
    `SELECT Id FROM User WHERE Email = '${e}' AND IsActive = true AND UserType = 'Standard' ORDER BY LastLoginDate DESC NULLS LAST LIMIT 1`,
  )
  const id = rows[0]?.Id ?? null
  ownerCache.set(e, { id, at: Date.now() })
  return id
}

/** An account's owner and client type, for opportunity ownership and Brand Direct pricing. */
export async function getSfdcAccountInfo(accountId: string): Promise<{ ownerId: string | null; clientType: 'Agency' | 'Brand Direct' } | null> {
  if (!/^[A-Za-z0-9]{15,18}$/.test(accountId)) return null
  const rows = await sfdcQuery<{ OwnerId: string | null; Owner?: { IsActive?: boolean } | null; Client_Type2__c: string | null }>(
    `SELECT OwnerId, Owner.IsActive, Client_Type2__c FROM Account WHERE Id = '${accountId}' LIMIT 1`,
  )
  if (!rows[0]) return null
  return {
    // An inactive owner cannot own a new opportunity (Salesforce rejects it),
    // so it is not offered as a fallback owner.
    ownerId: rows[0].Owner?.IsActive === false ? null : rows[0].OwnerId ?? null,
    clientType: String(rows[0].Client_Type2__c ?? '').trim().toLowerCase() === 'brand direct' ? 'Brand Direct' : 'Agency',
  }
}

/**
 * Who should own an opportunity: the internal user who created it (matched by
 * email), else the account's owner, else the integration user (null). Never
 * throws — ownership must not stop a booking.
 */
export async function resolveOpportunityOwner(opts: { creatorEmail?: string | null; accountOwnerId?: string | null }): Promise<{ ownerId: string | null; source: 'creator' | 'account_owner' | 'integration' }> {
  try {
    const mine = await findSfdcUserIdByEmail(opts.creatorEmail)
    if (mine) return { ownerId: mine, source: 'creator' }
  } catch (err) {
    console.error('[sfdc] owner lookup failed:', err)
  }
  if (opts.accountOwnerId) return { ownerId: opts.accountOwnerId, source: 'account_owner' }
  return { ownerId: null, source: 'integration' }
}
