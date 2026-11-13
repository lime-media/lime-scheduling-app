/**
 * What a market's media price is made of, as the single-market quote lists it
 * (components/QuoteBreakdown.tsx): base media, then each option chosen
 * (shadow fencing, smart directional, device ID passback). An option not
 * chosen is left out. Studies are the order's own row, never a market's. Pure.
 */
export function mediaParts(l: { baseMedia: number; shadowFencing: number; shadowFencingFloored: boolean; smartDirectional: number; deviceId: number }): { label: string; amount: number }[] {
  const parts = [{ label: 'Base media', amount: l.baseMedia }]
  if (l.shadowFencing > 0) parts.push({ label: `Shadow fencing${l.shadowFencingFloored ? ' (minimum applied)' : ''}`, amount: l.shadowFencing })
  if (l.smartDirectional > 0) parts.push({ label: 'Smart directional', amount: l.smartDirectional })
  if (l.deviceId > 0) parts.push({ label: 'Device ID passback', amount: l.deviceId })
  return parts
}
