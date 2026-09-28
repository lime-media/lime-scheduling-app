/** SOQL string safety helpers. Pure, so they can be tested and used anywhere. */

/**
 * Escape text for a SOQL string literal. Backslashes first, then quotes: a
 * search for \' must not close the string. (SOQL escapes: \\, \', and the
 * LIKE wildcards are left as typed.)
 */
export function soqlString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** A plain email address, safe to put in a SOQL string: no spaces, quotes or backslashes. */
export const SAFE_EMAIL = /^[^\s'"\\@]+@[^\s'"\\@]+$/
