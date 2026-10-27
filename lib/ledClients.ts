/**
 * Which LED client a Salesforce account is.
 *
 * A won deal's LED program belongs to an LED client (dbo.clients). LED has no
 * Salesforce link, and the names don't line up: LED's client is sometimes the
 * agency, sometimes the brand, and Salesforce names carry suffixes ("Inc").
 * So staff pick the LED client once per account (app_led_client_links), with
 * a suggestion from the names.
 */
import { query } from '@/lib/mssql'

export type LedClient = { client_uid: string; client: string }

const LED_CLIENTS_QUERY = `
SELECT CAST(client_uid AS NVARCHAR(36)) AS client_uid, LTRIM(RTRIM(client)) AS client
FROM dbo.clients
WHERE COALESCE(is_deleted, 0) = 0
ORDER BY client
`

/** Every live LED client, by name. Reads the LED database; throws if it can't. */
export async function ledClients(): Promise<LedClient[]> {
  const rows = await query<LedClient[]>(LED_CLIENTS_QUERY)
  return rows.map(r => ({ client_uid: r.client_uid.toLowerCase(), client: r.client }))
}

// Company suffixes and filler that differ between the two systems.
const NOISE = new Set(['inc', 'incorporated', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'the', 'group', 'agency'])

/** A name reduced for comparing: lower case, words only, company suffixes dropped. Pure. */
export function clientNameKey(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(w => w && !NOISE.has(w)).join(' ')
}

/**
 * The LED client a Salesforce account most likely is, or null: the one whose
 * name matches once both are reduced (`clientNameKey`), else the one whose
 * name contains the account's whole (or is contained in it), when exactly one
 * does. Only a suggestion; staff confirm it. Pure.
 */
export function suggestLedClient(accountName: string, clients: LedClient[]): LedClient | null {
  const key = clientNameKey(accountName)
  if (!key) return null
  const keyed = clients.map(c => ({ c, k: clientNameKey(c.client) })).filter(x => x.k)
  const exact = keyed.filter(x => x.k === key)
  if (exact.length === 1) return exact[0].c
  if (exact.length > 1) return null
  const words = (s: string) => ` ${s} `
  const partial = keyed.filter(x => words(x.k).includes(words(key)) || words(key).includes(words(x.k)))
  return partial.length === 1 ? partial[0].c : null
}
