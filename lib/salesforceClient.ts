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
  if (input.holdStart) body.LED_Hold_Start__c = input.holdStart
  if (input.holdStop) body.LED_Hold_Stop__c = input.holdStop
  if (input.holdExp) body.LED_Hold_Exp__c = input.holdExp
  if (input.truckNumbers && input.truckNumbers.length > 0) {
    body.LED_Trucks__c = input.truckNumbers.map(t => `LED-${t}`).join(';')
  }
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
  return res.status === 204
}

/**
 * Query Salesforce using SOQL.
 */
export async function sfdcQuery<T = Record<string, unknown>>(soql: string): Promise<T[]> {
  const res = await sfdcFetch(`/query?q=${encodeURIComponent(soql)}`)
  const data = await res.json()
  return data.records ?? []
}

/**
 * Check if SFDC credentials are configured.
 */
export function isSfdcConfigured(): boolean {
  return Boolean(SFDC_CLIENT_ID && SFDC_CLIENT_SECRET)
}
