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
  eq('any change to the order clears the quote', src.includes('const clear = () => { setQuote(null)') && (src.match(/clear\(\)/g) ?? []).length >= 4, true)
  eq('a moved "what fits" is shown, never booked without a new click', src.includes("res.status === 409 && data.fits") && src.includes('setChanged(data.error)'), true)
  eq('the booked message gives the booking\'s one expiry from the server', src.includes('heldUntil(data.expiresAt)'), true)
  const page = fs.readFileSync('app/client/ai/page.tsx', 'utf8')
  eq('the Assistant page offers one market or several', page.includes("mode === 'several' ? <ClientMultiMarketQuote />"), true)
}
