// Small shared display-formatting helpers used on both client and server.

/**
 * Combines a market and state for display, e.g. "Dallas, TX". Guards against
 * double-appending the state when `market` already ends with it (e.g. market
 * stored as "Dallas, TX" with state "TX" separately) — several places in this
 * app persist market already suffixed with the state, and naively joining
 * `[market, state]` produces "Dallas, TX, TX".
 */
export function formatMarketState(market?: string | null, state?: string | null): string {
  const m = (market ?? '').trim()
  const s = (state ?? '').trim()
  if (!s) return m
  if (!m) return s
  if (m.toLowerCase().endsWith(s.toLowerCase())) return m
  return `${m}, ${s}`
}
