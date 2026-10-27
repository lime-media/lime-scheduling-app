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
  /** Brand_Job_Name__c (50 characters): the brand, already cleaned (lib/brand.ts). */
  brand?: string
  /**
   * The opportunity's primary contact (a Contact on the account). Set as
   * Primary_Contact__c, which Contact Email/Phone read from; then, as a
   * separate best-effort step, added as the primary Opportunity Contact Role —
   * the two places a seller fills it in by hand. The role is separate so an
   * org that rejects it cannot take the opportunity down with it.
   */
  primaryContactId?: string
}

export type SfdcOpportunityResult = {
  success: boolean
  id?: string
  errors?: unknown[]
  /** Created, but something optional was not (the primary contact role). */
  warnings?: string[]
}

/** The checkbox that marks an opportunity made in the app (lib/opportunityOrigins.ts). */
export const CREATED_IN_APP_FIELD = 'Created_In_App__c'

// Set once Salesforce has refused CREATED_IN_APP_FIELD (not in this org yet, or
// not writable by the integration user): later creates in this process skip it
// instead of failing once more each.
let createdInAppRefused = false

/**
 * Whether a failed write was Salesforce refusing `field` itself: missing, or
 * not writable by this user (INVALID_FIELD, INVALID_FIELD_FOR_INSERT_UPDATE,
 * "No such column"), naming the field. Pure.
 */
export function fieldRefusedOnWrite(errors: unknown, field: string): boolean {
  const list = Array.isArray(errors) ? errors : [errors]
  return list.some(e => {
    const code = String((e as { errorCode?: unknown })?.errorCode ?? '')
    const text = `${code} ${String((e as { message?: unknown })?.message ?? '')} ${JSON.stringify((e as { fields?: unknown })?.fields ?? '')}`.toLowerCase()
    return /invalid_field|no such column/.test(text) && text.includes(field.toLowerCase())
  })
}

/**
 * Create a new Opportunity in Salesforce. It is marked made in the app
 * (CREATED_IN_APP_FIELD) when this org has the field; if Salesforce refuses
 * the field, it is created again without it, so the mark can never stop an
 * opportunity being made.
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
  if (input.brand) body.Brand_Job_Name__c = input.brand.slice(0, 50)
  if (input.primaryContactId) body.Primary_Contact__c = input.primaryContactId
  if (input.holdStart) body.LED_Hold_Start__c = input.holdStart
  if (input.holdStop) body.LED_Hold_Stop__c = input.holdStop
  if (input.holdExp) body.LED_Hold_Exp__c = input.holdExp
  if (input.truckNumbers && input.truckNumbers.length > 0) {
    body.LED_Trucks__c = input.truckNumbers.map(t => `LED-${t}`).join(';')
  }
  if (input.activationNotes) body.Activation_Notes__c = input.activationNotes.length > 500 ? input.activationNotes.slice(0, 497) + '...' : input.activationNotes
  if (input.description) body.Description = input.description.slice(0, 32000)
  // LED_Revenue__c is a read-only field (formula/rollup) — use Amount instead

  const post = async (fields: Record<string, unknown>) => {
    const res = await sfdcFetch('/sobjects/Opportunity', { method: 'POST', body: JSON.stringify(fields) })
    // Salesforce returns errors as [{ message, errorCode, fields }]; success as { id, success, errors }.
    const json = await res.json().catch(() => null)
    return { res, data: Array.isArray(json) ? { success: false, errors: json } : (json ?? { success: false }) }
  }
  let { res, data } = await post(createdInAppRefused ? body : { ...body, [CREATED_IN_APP_FIELD]: true })
  // Any refusal of a create with the mark is tried again without it: Salesforce words a
  // refused field more than one way (a validation rule, a field of another
  // type), and a failed create made nothing, so the retry can't duplicate.
  // It stops sending the mark once the field is known to be the cause.
  // Only a definite refusal (400, an error list) is retried: a 5xx or an
  // unreadable reply may still have made the opportunity.
  if (!data.success && !createdInAppRefused && res.status === 400 && Array.isArray(data.errors)) {
    const named = fieldRefusedOnWrite(data.errors, CREATED_IN_APP_FIELD)
    const first = data.errors
    ;({ res, data } = await post(body))
    if (data.success || named) {
      createdInAppRefused = true
      console.warn(`[sfdc] ${CREATED_IN_APP_FIELD} refused; creating opportunities without it:`, JSON.stringify(first))
    }
  }
  if (!data.success) {
    console.error('[sfdc] Opportunity creation failed. Status:', res.status, 'Response:', JSON.stringify(data))
  }
  const warnings: string[] = []
  if (data.success && data.id && input.primaryContactId) {
    if (!(await addPrimaryContactRole(data.id, input.primaryContactId))) {
      warnings.push('the primary contact was set, but could not be added under Contact Roles')
    }
  }
  return {
    success: data.success ?? false,
    id: data.id,
    errors: data.errors,
    ...(warnings.length ? { warnings } : {}),
  }
}

/**
 * Add a contact as an opportunity's primary Contact Role. Best-effort: false
 * (and logged) when Salesforce refuses or cannot be reached; never throws.
 */
async function addPrimaryContactRole(opportunityId: string, contactId: string): Promise<boolean> {
  try {
    const res = await sfdcFetch('/sobjects/OpportunityContactRole', {
      method: 'POST',
      body: JSON.stringify({ OpportunityId: opportunityId, ContactId: contactId, IsPrimary: true }),
    })
    if (res.ok) return true
    console.error(`[sfdc] contact role for ${opportunityId} refused: HTTP ${res.status}`, await res.text().catch(() => ''))
  } catch (err) {
    console.error(`[sfdc] contact role for ${opportunityId} failed:`, err)
  }
  return false
}

/**
 * Update an existing Opportunity in Salesforce.
 */
export async function updateOpportunity(
  opportunityId: string,
  fields: Partial<Record<string, unknown>>,
): Promise<boolean> {
  return (await updateOpportunityWithError(opportunityId, fields)).ok
}

/**
 * updateOpportunity, with Salesforce's reason when it refuses, for callers
 * that show it to the person (a validation rule's message, say).
 */
export async function updateOpportunityWithError(
  opportunityId: string,
  fields: Partial<Record<string, unknown>>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await sfdcFetch(`/sobjects/Opportunity/${opportunityId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  })

  // SFDC returns 204 No Content on success
  if (res.status === 204) return { ok: true }

  // Log why. The common failure is an invalid picklist value (StageName), which
  // is otherwise indistinguishable from any other rejection at the call site.
  const body = await res.json().catch(() => null)
  const detail = Array.isArray(body) && body[0]?.message
    ? `${body[0].errorCode}: ${body[0].message}`
    : `HTTP ${res.status}`
  console.error(`[sfdc] Opportunity ${opportunityId} update failed — ${detail}`, fields)
  return { ok: false, error: detail }
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
 * A SOQL query's every row: follows Salesforce's pages (nextRecordsUrl, 2,000
 * rows each) up to `maxRows`. `truncated` says rows were left out.
 */
export async function sfdcQueryAll<T = Record<string, unknown>>(soql: string, maxRows = 20_000): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  let path: string | null = `/query?q=${encodeURIComponent(soql)}`
  while (path) {
    const res = await sfdcFetch(path)
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const detail = Array.isArray(data) && data[0]?.message ? `${data[0].errorCode}: ${data[0].message}` : `HTTP ${res.status}`
      throw new Error(`Salesforce SOQL query failed — ${detail}`)
    }
    rows.push(...(data?.records ?? []))
    if (rows.length >= maxRows) return { rows: rows.slice(0, maxRows), truncated: !data?.done || rows.length > maxRows }
    // nextRecordsUrl is absolute from /services/data/<version>; sfdcFetch adds that prefix.
    path = data?.done === false && typeof data.nextRecordsUrl === 'string'
      ? data.nextRecordsUrl.replace(/^\/services\/data\/[^/]+/, '')
      : null
  }
  return { rows, truncated: false }
}

/**
 * Whether a failed query was Salesforce refusing `field` itself: missing in
 * this org, or hidden from the integration user ("INVALID_FIELD ... No such
 * column '<field>'"). The message repeats the whole query, so the column it
 * names is what's matched, not any mention of the field. Pure.
 */
export function fieldUnreadable(err: unknown, field: string): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /INVALID_FIELD/.test(msg) && msg.toLowerCase().includes(`no such column '${field.toLowerCase()}'`)
}

/**
 * A query with an optional field: if the query with that field fails for any
 * reason, it runs again without it, so what doesn't depend on the field still
 * works. Salesforce words a refused field more than one way, so this doesn't
 * rely on the wording (fieldUnreadable only picks the log line). A real outage
 * fails the second query too and throws as before. `withField` says which
 * ran; `refused`, that Salesforce said it can't read the field. A caller
 * querying in chunks stops asking for the field once it is refused (passing
 * `tryField` false), so it is asked for once per run, not per chunk, while
 * a passing failure only costs the chunk it hit.
 */
export async function sfdcQueryOptionalField<T = Record<string, unknown>>(
  field: string,
  build: (withField: boolean) => string,
  tryField = true,
): Promise<{ rows: T[]; withField: boolean; refused: boolean }> {
  if (!tryField) return { rows: await sfdcQuery<T>(build(false)), withField: false, refused: true }
  try {
    return { rows: await sfdcQuery<T>(build(true)), withField: true, refused: false }
  } catch (err) {
    const refused = fieldUnreadable(err, field)
    console.error(refused
      ? `[sfdc] ${field} not readable; querying without it:`
      : `[sfdc] query with ${field} failed; trying without it:`, err)
    return { rows: await sfdcQuery<T>(build(false)), withField: false, refused }
  }
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
import { soqlString } from './soql'
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
/**
 * Whether `contactId` is a Contact on `accountId` — the server's check of the
 * primary contact a page sends, so an opportunity never points at someone
 * else's contact. False when it is not; throws when Salesforce cannot be read.
 */
/** A Salesforce Contact id (prefix 003, 15 or 18 characters). Pure. */
export const isContactId = (id: unknown): id is string => typeof id === 'string' && /^003[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(id)

export async function isContactOfAccount(contactId: string, accountId: string): Promise<boolean> {
  if (!isContactId(contactId)) return false
  const rows = await sfdcQuery<{ Id: string }>(
    `SELECT Id FROM Contact WHERE Id = '${soqlString(contactId)}' AND AccountId = '${soqlString(accountId)}' LIMIT 1`,
  )
  return rows.length === 1
}

/**
 * The booking's primary contact, checked. Every opportunity needs one (sales
 * ops' rule), and it must be a Contact on the chosen account.
 * - `refusal`: a definite no — none chosen, or not on the account. The
 *   booking is refused.
 * - `warning`: Salesforce could not be read to check. The booking goes
 *   ahead, as it does when the opportunity itself cannot be created: the hold
 *   is what keeps the truck from being sold twice, and the rep is told.
 * Salesforce not configured (local dev): neither.
 */
export async function checkPrimaryContact(contactId: unknown, accountId: string): Promise<{ refusal: string | null; warning: string | null }> {
  if (!isContactId(contactId)) return { refusal: 'Choose the primary contact for this opportunity.', warning: null }
  if (!isSfdcConfigured()) return { refusal: null, warning: null }
  try {
    return (await isContactOfAccount(contactId, accountId))
      ? { refusal: null, warning: null }
      : { refusal: 'That contact is not on the selected Salesforce account. Choose the primary contact again.', warning: null }
  } catch (err) {
    console.error('[sfdc] primary contact check failed:', err)
    return { refusal: null, warning: 'the primary contact could not be verified with Salesforce' }
  }
}

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
