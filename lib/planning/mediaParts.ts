/**
 * What a market's media price is made of, as the single-market quote lists it
 * (components/QuoteBreakdown.tsx): base media, then each option chosen
 * (shadow fencing, smart directional, device ID passback). An option not
 * chosen is left out. Studies are the order's own row, never a market's.
 *
 * Base media is the market's shown media (its media less any lift studies
 * it carries for the order: applyStudies adds the order's studies to one
 * market's media, and the Media column shows them on their own row) less the
 * options, not its own rounded figure, so the parts always add up to the
 * Media beside them: the
 * quote rounds each part and the sum separately (up to $2 apart), and a kept
 * booked price (keepBookedPrices) pairs the booked media with stored option
 * prices that may fall back to today's. Where the options alone exceed the
 * media (an old booking stored without them), the split is unknown and
 * nothing is listed. Pure.
 */
export function mediaParts(l: { media: number; studiesTotal: number; shadowFencing: number; shadowFencingFloored: boolean; smartDirectional: number; deviceId: number }): { label: string; amount: number }[] {
  const options: { label: string; amount: number }[] = []
  if (l.shadowFencing > 0) options.push({ label: `Shadow fencing${l.shadowFencingFloored ? ' (minimum applied)' : ''}`, amount: l.shadowFencing })
  if (l.smartDirectional > 0) options.push({ label: 'Smart directional', amount: l.smartDirectional })
  if (l.deviceId > 0) options.push({ label: 'Device ID passback', amount: l.deviceId })
  const base = l.media - l.studiesTotal - options.reduce((s, p) => s + p.amount, 0)
  if (base < 0) return []
  return [{ label: 'Base media', amount: base }, ...options]
}
