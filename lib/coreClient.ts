/**
 * CampaignIQ Core's campaign request intake, as the "Scheduling App" service
 * account (Core contract, 2026-11-10): log in for a token, then
 * POST /api/v1/campaigns. Create only for now; updates, approve, reject and
 * archive wait for Core's shapes.
 *
 * Off unless CORE_SEND_ENABLED is "true" and every setting is there, so UAT
 * and production send nothing until they're configured. Credentials and
 * tokens are never logged.
 */

import type { CampaignRequest, DayFlags } from '@/lib/campaignRequests'

export type CoreConfig = { authUrl: string; apiUrl: string; username: string; password: string }

const SETTINGS = ['CORE_AUTH_URL', 'CORE_API_URL', 'CORE_USERNAME', 'CORE_PASSWORD'] as const

/** The settings to send with, or why sending is off. Pure. */
export function coreConfig(env: Record<string, string | undefined>): { ok: true; config: CoreConfig } | { ok: false; reason: string } {
  if (env.CORE_SEND_ENABLED?.trim() !== 'true') return { ok: false, reason: 'Sending to LED is turned off here (CORE_SEND_ENABLED).' }
  const missing = SETTINGS.filter(k => !env[k]?.trim())
  if (missing.length > 0) return { ok: false, reason: `Sending to LED isn't set up: ${missing.join(', ')} missing.` }
  return {
    ok: true,
    config: {
      authUrl: env.CORE_AUTH_URL!.trim(),
      apiUrl: env.CORE_API_URL!.trim().replace(/\/+$/, ''),
      username: env.CORE_USERNAME!.trim(),
      password: env.CORE_PASSWORD!,
    },
  }
}

// ── The request body ─────────────────────────────────────────────────────────

/** Core's day names, Monday first. */
const CORE_DAYS: [keyof DayFlags, string][] = [
  ['monday', 'MONDAY'], ['tuesday', 'TUESDAY'], ['wednesday', 'WEDNESDAY'], ['thursday', 'THURSDAY'],
  ['friday', 'FRIDAY'], ['saturday', 'SATURDAY'], ['sunday', 'SUNDAY'],
]

export type CorePayload = {
  clientUid: string
  campaignName: string
  campaignStartDate: string
  campaignEndDate: string
  externalRef: string
  soldAmount?: number
  markets: {
    standardMarketUid: string
    marketStartDate: string
    marketEndDate: string
    duration: string
    truckCount: number
    operatingDays: string[]
    truckNumbers: string[]
  }[]
}

/**
 * A built request as Core's create body, or why it can't be sent. Core
 * rejects a request without its client or a market's standard market, and
 * the contract says fail loudly rather than guess, so neither is defaulted.
 * Days are always sent: an unconfirmed schedule is all seven (the builder
 * flags it for ops). Pure.
 */
export function corePayload(r: CampaignRequest): { ok: true; body: CorePayload } | { ok: false; error: string } {
  if (!r.clientUid) return { ok: false, error: 'No LED client is linked to its account.' }
  if (r.externalRef.length > 100) return { ok: false, error: `Its reference is longer than LED accepts (${r.externalRef.length} of 100 characters).` }
  if (r.markets.length === 0) return { ok: false, error: 'It has no markets.' }
  const unlocated = r.markets.filter(m => !m.standardMarketUid)
  if (unlocated.length > 0) return { ok: false, error: `Not on LED's market list: ${unlocated.map(m => m.otherMarketName ?? m.key).join('; ')}.` }
  const empty = r.markets.filter(m => m.trucks.length === 0)
  if (empty.length > 0) return { ok: false, error: 'A market has no truck assigned.' }
  return {
    ok: true,
    body: {
      clientUid: r.clientUid,
      campaignName: r.campaignName.slice(0, 150),
      campaignStartDate: r.startDate,
      campaignEndDate: r.endDate,
      externalRef: r.externalRef,
      ...(r.soldAmount !== null ? { soldAmount: r.soldAmount } : {}),
      markets: r.markets.map(m => ({
        standardMarketUid: m.standardMarketUid!,
        marketStartDate: m.startDate,
        marketEndDate: m.endDate,
        duration: m.duration,
        truckCount: m.trucks.length,
        operatingDays: CORE_DAYS.filter(([flag]) => m.days[flag]).map(([, name]) => name),
        truckNumbers: m.trucks,
      })),
    },
  }
}

// ── Calls ────────────────────────────────────────────────────────────────────

/** A refusal or failure from Core, with a message written to be shown. */
export class CoreError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message)
    this.name = 'CoreError'
  }
}

export type CoreCreated = { coreUid: string; requestId: string | null; status: string | null }

type Fetch = (url: string, init: RequestInit) => Promise<Response>

const TIMEOUT_MS = 20_000

/** Core's own message for a refusal: `message`, plus `errors` when it lists them. */
function coreMessage(body: unknown, status: number): string {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const msg = typeof b.message === 'string' && b.message.trim() ? b.message.trim() : null
  const errors = Array.isArray(b.errors) ? b.errors.map(e => (typeof e === 'string' ? e : (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : null))).filter(Boolean) : []
  const parts = [msg, ...errors].filter((p, i, all) => p && all.indexOf(p) === i)
  return parts.length > 0 ? `LED refused it: ${parts.join('; ')}` : `LED answered ${status} with no reason given.`
}

/** Tokens by account, kept for the life of the server instance. */
const tokens = new Map<string, string>()

/** Forget cached tokens (tests). */
export function clearCoreTokens(): void {
  tokens.clear()
}

/**
 * A client for one Core account. A token is reused until Core answers 401,
 * then the account logs in again once and the call is retried once.
 */
export function coreClient(config: CoreConfig, doFetch: Fetch = fetch) {
  const tokenKey = `${config.authUrl}|${config.username}`

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new CoreError(timedOut ? "LED didn't answer in time. Sending again is safe." : "LED couldn't be reached. Sending again is safe.", null)
    }
  }

  async function login(): Promise<string> {
    const res = await call(config.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress: config.username, password: config.password }),
    })
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    if (body?.otpRequired === true) throw new CoreError('LED asked the Scheduling App account for an emailed code, which it can\'t answer. LED must turn that off for the account.', res.status)
    const token = typeof body?.token === 'string' ? body.token : null
    if (!res.ok || !token) throw new CoreError(res.status === 401 || res.status === 403 ? 'LED refused the Scheduling App account\'s login: check its credentials, or whether the account is disabled.' : coreMessage(body, res.status), res.status)
    tokens.set(tokenKey, token)
    return token
  }

  async function authed(url: string, init: RequestInit): Promise<Response> {
    const first = tokens.get(tokenKey) ?? await login()
    const res = await call(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${first}` } })
    if (res.status !== 401) return res
    // Tokens expire: log in once more and retry once.
    tokens.delete(tokenKey)
    const fresh = await login()
    const again = await call(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${fresh}` } })
    if (again.status === 401) throw new CoreError('LED refused the Scheduling App account (401). The account may be disabled.', 401)
    return again
  }

  /** Create a request. The same externalRef returns the original request, so a retry is safe. */
  async function createCampaign(body: CorePayload): Promise<CoreCreated> {
    const res = await authed(`${config.apiUrl}/api/v1/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null) as Record<string, unknown> | null
    const data = json?.data && typeof json.data === 'object' ? json.data as Record<string, unknown> : null
    const uid = typeof data?.campaignRequestUid === 'string' ? data.campaignRequestUid : null
    const statusCode = typeof json?.statusCode === 'number' ? json.statusCode : res.status
    if (!res.ok || statusCode >= 300 || !uid) throw new CoreError(coreMessage(json, statusCode), statusCode)
    return {
      coreUid: uid,
      requestId: typeof data?.requestId === 'string' ? data.requestId : null,
      status: typeof data?.status === 'string' ? data.status : null,
    }
  }

  return { createCampaign }
}
