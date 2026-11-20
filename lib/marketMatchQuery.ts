/** The match routes' query: market text (q, 2–120 characters) and an optional two-letter state. Pure. */
export function readMatchQuery(p: URLSearchParams): { text: string; state?: string } | { error: string } {
  const text = (p.get('q') ?? '').trim()
  if (text.length < 2) return { error: 'q is the market text, at least 2 characters' }
  if (text.length > 120) return { error: 'q is at most 120 characters' }
  const state = (p.get('state') ?? '').trim()
  if (state && !/^[A-Za-z]{2}$/.test(state)) return { error: 'state is a two-letter code' }
  return state ? { text, state } : { text }
}
