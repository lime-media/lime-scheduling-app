export const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
}

export const US_STATE_ABBREVIATIONS = Object.keys(US_STATE_NAMES).sort()

const CODE_BY_NAME = new Map(Object.entries(US_STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]))

/** A state as its two-letter code ("ks", "Kansas" → "KS"), or '' when it isn't one. Pure. */
export function stateCode(v: string | null | undefined): string {
  const t = (v ?? '').trim()
  if (/^[a-z]{2}$/i.test(t) && US_STATE_NAMES[t.toUpperCase()]) return t.toUpperCase()
  return CODE_BY_NAME.get(t.toLowerCase().replace(/\s+/g, ' ')) ?? ''
}


/**
 * Common written abbreviations of a state name (AP style, dots dropped:
 * "Tex.", "Calif.", "N.Y." as "NY" is already a code). Only for reading free
 * market text: stateCode stays strict for every other caller.
 */
const STATE_ABBREVIATIONS: Record<string, string> = {
  ala: 'AL', ariz: 'AZ', ark: 'AR', calif: 'CA', cal: 'CA', colo: 'CO', conn: 'CT', del: 'DE', fla: 'FL',
  ill: 'IL', ind: 'IN', kan: 'KS', kans: 'KS', ky: 'KY', md: 'MD', mass: 'MA', mich: 'MI', minn: 'MN',
  miss: 'MS', mont: 'MT', neb: 'NE', nebr: 'NE', nev: 'NV', okla: 'OK', ore: 'OR', oreg: 'OR', penn: 'PA', penna: 'PA',
  tenn: 'TN', tex: 'TX', wash: 'WA', wis: 'WI', wisc: 'WI', wva: 'WV', wyo: 'WY', vt: 'VT', va: 'VA',
}

/**
 * A state written any common way in market text, as its code: a code or full
 * name ("TX", "Texas"), an abbreviation ("Tex", "Calif"), or the first state of
 * a metro spanning several ("MO-KS", "NY-NJ-PA" → MO, NY). '' when it isn't
 * one. Pure.
 */
export function stateFromText(v: string | null | undefined): string {
  const t = (v ?? '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
  if (!t) return ''
  const code = stateCode(t) || STATE_ABBREVIATIONS[t] || ''
  if (code) return code
  const parts = t.split(/\s*[-/]\s*/)
  if (parts.length > 1 && parts.every(p => stateCode(p) || STATE_ABBREVIATIONS[p])) return stateCode(parts[0]) || STATE_ABBREVIATIONS[parts[0]]
  return ''
}

/**
 * Whether a word could be a state written some way stateFromText doesn't
 * know ("Pensylvania", "Texs"): it shares its first three letters with a
 * state's name. Such text is never read as a region, so a misspelled state
 * can't take another state's city. Pure.
 */
export function mayBeState(word: string): boolean {
  const w = word.trim().toLowerCase()
  if (w.length < 3) return true
  return Object.values(US_STATE_NAMES).some(n => n.toLowerCase().startsWith(w.slice(0, 3)))
}
