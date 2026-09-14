/**
 * Editable application settings.
 *
 * Operational configuration that changes with people rather than with code —
 * who receives which notification, for instance — belongs somewhere a person
 * can edit it. Hardcoding it is how the inbound-reservation alert ended up
 * pointed at one person with the real list commented out above it, and how it
 * stayed that way: fixing it needed a code change, a PR and a promotion.
 *
 * Resolution order, so nothing breaks when a layer is missing:
 *
 *   1. the app_settings row   — edited in the UI, wins
 *   2. the environment var    — deploy-level override, still honoured
 *   3. the compiled default   — always correct, never empty
 *
 * A short cache keeps the hourly sweep and burst sends from querying per email
 * without making an edit wait minutes to take effect.
 */

import { prisma } from '@/lib/prisma'

/** Prisma P2021 — the table does not exist in the current database. */
function isMissingTableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code?: unknown }).code === 'P2021'
}

export type SettingKey =
  | 'notify.holds'
  | 'notify.assist'
  | 'notify.conflicts'

type SettingSpec = {
  key: SettingKey
  label: string
  description: string
  /** Deploy-level override, honoured when no row exists. */
  envVar: string
  /** Last resort. Never empty, so a notification can always be delivered. */
  fallback: string
}

export const SETTING_SPECS: SettingSpec[] = [
  {
    key: 'notify.holds',
    label: 'New client reservations',
    description: 'A client successfully booked a truck through the portal or the AI assistant.',
    envVar: 'HOLD_NOTIFY_EMAIL',
    fallback: 'andrew@lime-media.com',
  },
  {
    key: 'notify.assist',
    label: 'Client assistance requests',
    description: 'A client could not self-serve and asked for a human — failed quotes, hold extension requests, and AI chat escalations.',
    envVar: 'ASSIST_NOTIFY_EMAIL',
    fallback: 'andrew@lime-media.com',
  },
  {
    key: 'notify.conflicts',
    label: 'Schedule conflicts',
    description: 'A hold was detected overlapping a scheduled LED program.',
    envVar: 'NOTIFY_EMAIL',
    fallback: 'andrew@lime-media.com',
  },
]

const SPEC_BY_KEY = new Map(SETTING_SPECS.map(s => [s.key, s]))

const CACHE_TTL_MS = 30_000
let cache: { at: number; values: Map<string, string> } | null = null

async function loadAll(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values
  try {
    const rows = await prisma.appSetting.findMany()
    const values = new Map(rows.map(r => [r.key, r.value]))
    cache = { at: Date.now(), values }
    return values
  } catch (err) {
    // Either way the caller falls through to env/defaults so a notification
    // still goes out — but these are very different situations and must not
    // look identical in the logs. P2021 is "the migration has not run here",
    // which is expected and benign. Anything else is a real database problem
    // masquerading as one.
    if (isMissingTableError(err)) {
      console.warn('[appSettings] app_settings not present yet — using env/defaults')
    } else {
      console.error('[appSettings] DATABASE ERROR reading settings, using env/defaults:', err)
    }
    return cache?.values ?? new Map()
  }
}

/** Resolve one setting: stored row, then env var, then compiled default. */
export async function getSetting(key: SettingKey): Promise<string> {
  const spec = SPEC_BY_KEY.get(key)
  if (!spec) throw new Error(`Unknown setting: ${key}`)

  const stored = (await loadAll()).get(key)?.trim()
  if (stored) return stored

  const fromEnv = process.env[spec.envVar]?.trim()
  if (fromEnv) return fromEnv

  return spec.fallback
}

export type ResolvedSetting = {
  key: SettingKey
  label: string
  description: string
  value: string
  /** Where the effective value came from — shown in the UI so it is not a mystery. */
  source: 'stored' | 'env' | 'default'
  envVar: string
  updatedAt: string | null
  updatedBy: string | null
}

/** Every setting with its effective value and provenance, for the settings page. */
export async function getAllSettings(): Promise<ResolvedSetting[]> {
  let rows: { key: string; value: string; updated_at: Date; updated_by: string | null }[] = []
  try {
    rows = await prisma.appSetting.findMany()
  } catch (err) {
    if (isMissingTableError(err)) {
      console.warn('[appSettings] app_settings not present yet — showing env/defaults')
    } else {
      console.error('[appSettings] DATABASE ERROR reading settings:', err)
    }
  }
  const byKey = new Map(rows.map(r => [r.key, r]))

  return SETTING_SPECS.map(spec => {
    const row = byKey.get(spec.key)
    const stored = row?.value?.trim()
    const fromEnv = process.env[spec.envVar]?.trim()

    const [value, source]: [string, ResolvedSetting['source']] =
      stored ? [stored, 'stored']
      : fromEnv ? [fromEnv, 'env']
      : [spec.fallback, 'default']

    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      value,
      source,
      envVar: spec.envVar,
      updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
      updatedBy: row?.updated_by ?? null,
    }
  })
}

export async function setSetting(key: SettingKey, value: string, updatedBy: string): Promise<void> {
  if (!SPEC_BY_KEY.has(key)) throw new Error(`Unknown setting: ${key}`)
  await prisma.appSetting.upsert({
    where:  { key },
    update: { value, updated_by: updatedBy },
    create: { key, value, updated_by: updatedBy },
  })
  cache = null // edits take effect immediately, not in 30 seconds
}

/** Basic sanity for a comma-separated recipient list. Returns an error, or null. */
export function validateEmailList(value: string): string | null {
  const parts = value.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length === 0) return 'At least one email address is required'
  const bad = parts.filter(p => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p))
  if (bad.length > 0) return `Not a valid email address: ${bad.join(', ')}`
  return null
}
