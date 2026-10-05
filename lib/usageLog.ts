/**
 * Usage log: every quote and AI run in the app — who ran it, when, which tool,
 * what went in, what came out, how it ended and how long it took. Shown on the
 * Usage page; MCP tool calls are logged separately by the MCP server
 * (mcp_query_log) and shown alongside.
 *
 * Wired once per route with withUsageLog(), so no early return inside a
 * handler can skip the log. Logging NEVER affects the request: the write runs
 * after the response is sent (waitUntil, which keeps the function alive until
 * it lands), and a failed write is caught and printed, never thrown.
 *
 * Also keeps "last activity" on the person (touchActivity), shown on the Users
 * page — written at most once every ACTIVITY_THROTTLE_MIN per person.
 */

import { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { waitUntil } from '@vercel/functions'
import { prisma } from '@/lib/prisma'
import { getClientSession } from '@/lib/clientAuth'

import type { UsageTool } from '@/lib/usageFormat'
export { TOOL_LABELS, type UsageTool } from '@/lib/usageFormat'

export type Actor = { type: 'app_user' | 'client_user'; id: string; name: string }
export type Outcome = 'success' | 'not_feasible' | 'refused' | 'error'

// ── Pure: what is stored ─────────────────────────────────────────────────────

const MAX_JSON = 8000
const LONG_TEXT = new Set(['message', 'question', 'text', 'csv', 'content', 'notes'])
// Never stored, whatever route they arrive on: credentials and personal identifiers.
export const SECRET = /pass(word|wd)?|pwd|secret|token|otp|code_hash|auth|api[-_]?key|private[-_]?key|credential|cookie|session|ssn/i

function clip(s: string, n: number): string { return s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s }

function prunePrimitive(key: string, v: unknown): unknown {
  if (typeof v === 'string') return clip(v, LONG_TEXT.has(key) ? 500 : 200)
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v
  return undefined
}

/** The request inputs worth keeping: primitives, short strings, and the first rows of any list. Never secrets. */
export function pruneInputs(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (SECRET.test(k)) continue
    if (Array.isArray(v)) {
      const items = v.slice(0, 20).map(item =>
        item && typeof item === 'object'
          ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([ik]) => !SECRET.test(ik)).map(([ik, iv]) => [ik, prunePrimitive(ik, iv)]).filter(([, iv]) => iv !== undefined))
          : prunePrimitive(k, item))
      out[k] = v.length > 20 ? { first: items, count: v.length } : items
    } else if (v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([ik]) => !SECRET.test(ik)).map(([ik, iv]) => [ik, prunePrimitive(ik, iv)]).filter(([, iv]) => iv !== undefined))
    } else {
      const p = prunePrimitive(k, v)
      if (p !== undefined) out[k] = p
    }
  }
  return out
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown, n = 300) => (typeof v === 'string' && v ? clip(v, n) : undefined)

/** The headline of a response: a total, how many holds, a refusal, an error. */
export function summarizeResult(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== 'object') return {}
  const j = json as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Record<string, unknown> = {
    total: num(j.grandTotal) ?? num(j.quote?.summary?.grandTotal) ?? num(j.pricing?.grandTotal) ?? num(j.quote?.grandTotal),
    good: num(j.presets?.good?.total),
    best: num(j.presets?.best?.total),
    market: str(j.market, 100),
    holds: Array.isArray(j.created) ? j.created.length : num(j.created),
    failed: Array.isArray(j.failed) ? j.failed.length : undefined,
    markets: num(j.quote?.summary?.markets),
    trucks: num(j.quote?.summary?.trucksUsed),
    areas: Array.isArray(j.areas) ? j.areas.length : undefined,
    findings: Array.isArray(j.findings) ? j.findings.length : undefined,
    reply: str(j.reply, 300),
    insufficient: j.insufficient === true ? true : undefined,
    error: str(j.error) ?? str(j.message),
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

/** How a run ended, from its HTTP status and body. */
export function outcomeFor(status: number, json: unknown): Outcome {
  if (status >= 500) return 'error'
  if (status >= 400) return 'refused'
  const j = (json ?? {}) as Record<string, unknown>
  if (j.insufficient === true) return 'not_feasible'
  return 'success'
}

const capJson = (v: unknown) => { const s = JSON.stringify(v); return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}…` : s }

// ── Who is asking ────────────────────────────────────────────────────────────

export async function staffActor(req: NextRequest): Promise<Actor | null> {
  const t = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!t?.id) return null
  return { type: 'app_user', id: String(t.id), name: String(t.name ?? t.email ?? '') }
}
export function clientActor(req: NextRequest): Actor | null {
  const s = getClientSession(req)
  return s ? { type: 'client_user', id: s.id, name: `${s.companyName} (${s.username})` } : null
}

// ── Writes (never throw) ─────────────────────────────────────────────────────

export const ACTIVITY_THROTTLE_MIN = 10

/** Mark a person active now — at most once every ACTIVITY_THROTTLE_MIN. */
export async function touchActivity(actor: Actor): Promise<void> {
  const cutoff = new Date(Date.now() - ACTIVITY_THROTTLE_MIN * 60_000)
  const where = { id: actor.id, OR: [{ last_active_at: null }, { last_active_at: { lt: cutoff } }] }
  try {
    if (actor.type === 'app_user') await prisma.user.updateMany({ where, data: { last_active_at: new Date() } })
    else await prisma.clientUser.updateMany({ where, data: { last_active_at: new Date() } })
  } catch (err) {
    console.error('[usage] last activity not recorded:', err instanceof Error ? err.message : err)
  }
}

async function record(actor: Actor, tool: UsageTool, inputs: unknown, status: number, json: unknown, latencyMs: number) {
  try {
    await prisma.usageLog.create({
      data: {
        actor_type: actor.type, actor_id: actor.id, actor_name: actor.name.slice(0, 500), tool,
        inputs: capJson(inputs), result: capJson(summarizeResult(json)),
        outcome: outcomeFor(status, json), status, latency_ms: latencyMs,
      },
    })
  } catch (err) {
    console.error(`[usage] ${tool} run not logged:`, err instanceof Error ? err.message : err)
  }
  await touchActivity(actor)
}

/** A form upload's fields: same redaction as JSON; a file is only its name and size. */
export function pruneFormEntries(entries: [string, string | { name: string; size: number }][]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    if (SECRET.test(k)) continue
    out[k] = typeof v === 'string' ? clip(v, 500) : { file: v.name, bytes: v.size }
  }
  return out
}

/** What went in: the JSON body, or for a file upload only its name and size. */
async function readInputs(req: NextRequest): Promise<unknown> {
  try {
    const type = req.headers.get('content-type') ?? ''
    if (type.includes('multipart/form-data')) {
      return pruneFormEntries([...(await req.clone().formData()).entries()])
    }
    return pruneInputs(await req.clone().json())
  } catch {
    return {}
  }
}

/**
 * Wrap a route handler so every run is logged — success, refusal or crash.
 * Unauthenticated requests are not logged (there is no one to attribute them to).
 */
export function withUsageLog(
  tool: UsageTool,
  who: 'staff' | 'client',
  handler: (req: NextRequest) => Promise<Response>,
): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest) => {
    const started = Date.now()
    const [actor, inputs] = await Promise.all([who === 'staff' ? staffActor(req) : Promise.resolve(clientActor(req)), readInputs(req)])
    let res: Response
    try {
      res = await handler(req)
    } catch (err) {
      if (actor) waitUntil(record(actor, tool, inputs, 500, { error: err instanceof Error ? err.message : String(err) }, Date.now() - started))
      throw err
    }
    if (actor) {
      // Off the critical path: the person gets the response now; the log is
      // written after it is sent.
      const latency = Date.now() - started
      const copy = res.clone()
      waitUntil((async () => {
        let json: unknown = null
        try { json = await copy.json() } catch { /* not JSON */ }
        await record(actor, tool, inputs, res.status, json, latency)
      })())
    }
    return res
  }
}

