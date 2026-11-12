/**
 * The client portal's multi-market form books only what it showed.
 *
 * Run with: npm test
 */
import fs from 'fs'
import { eq, section } from './harness'

section('client multi-market form')
{
  const src = fs.readFileSync('components/ClientMultiMarketQuote.tsx', 'utf8')
  eq('books at the total and trucks per market shown for what fits', src.includes('expectedTotal: quote.fits.total') && src.includes('expectedTrucks: Object.fromEntries(quote.fits.lines.map(l => [l.id, l.trucks]))'), true)
  eq('one request id per quote, so a retry after a network error books once', src.includes('requestId: quote.requestId') && src.includes('requestId: requestIdFor()'), true)
  eq('any change to the order clears the quote', src.includes('const clear = () => { quoteSeq.current++; setQuote(null)') && (src.match(/clear\(\)/g) ?? []).length >= 4, true)
  eq('a moved "what fits" is shown, never booked without a new click', src.includes("res.status === 409 && data.fits") && src.includes('setChanged(data.error)'), true)
  eq('the booked message gives the booking\'s one expiry from the server', src.includes('heldUntil(data.expiresAt)'), true)
  eq('Book posts the quoted rows and features, not the live form', src.includes('rows: quote.rows.map(rowBody)') && src.includes('features: quote.features') && !src.includes('rows: rows.map('), true)
  eq('a quote reply for an order changed since is dropped', src.includes('if (seq !== quoteSeq.current) return'), true)
  eq('the form is locked while a quote or booking is in flight', src.includes('<fieldset disabled={busy}') && src.includes('const busy = loading || booking'), true)
  eq('a placed booking shows outside the quote card', src.includes('{booked && <div'), true)
  eq('a 409 replaces the as-asked view too, so the note matches what fits', src.includes('asked: data.asked ?? q.asked'), true)
  const lib = fs.readFileSync('lib/clientMultiMarket.ts', 'utf8')
  eq('the 409 "what fits changed" reply carries the order as asked', /asked: view\(asked\),\s*short: asked\.plan\.shortfalls\.length > 0,\s*fits: view\(fits\)/.test(lib), true)
  const page = fs.readFileSync('app/client/ai/page.tsx', 'utf8')
  eq('the Assistant page offers one market or several', page.includes("'several', 'Several markets'"), true)
  eq('the several-markets form stays mounted across a tab switch', page.includes("<div className={mode === 'several' ? 'contents' : 'hidden'}><ClientMultiMarketQuote /></div>"), true)
}
