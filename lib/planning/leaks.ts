/**
 * The client-text leak check, kept free of server imports so the planner tab
 * can re-run it in the browser as a rep edits the client text.
 */

/** Which forbidden terms appear in a text (whole words, case-insensitive; "stem*" matches any ending). */
export function findLeaks(text: string, forbidden: string[]): string[] {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return forbidden.filter(t => {
    const stem = t.endsWith('*')
    const body = esc(stem ? t.slice(0, -1) : t)
    return new RegExp(`(^|[^A-Za-z0-9])${body}${stem ? '' : '(?![A-Za-z0-9])'}`, 'i').test(text)
  })
}
