/**
 * Opportunity stages a seller may pick when a quote creates an opportunity.
 *
 * Only the open stages — Salesforce's Opportunity.StageName picklist values
 * COLD, WARM and "Hot / Estimate Sent" (verified against the org). Closed Won
 * and the Closed Lost reasons are set in Salesforce, never from a quote.
 */

export const OPEN_STAGES = [
  { value: 'COLD', label: 'Cold' },
  { value: 'WARM', label: 'Warm' },
  { value: 'Hot / Estimate Sent', label: 'Hot' },
] as const

export type OpenStage = (typeof OPEN_STAGES)[number]['value']

/** What an opportunity starts as when nothing is chosen (what the app always used). */
export const DEFAULT_STAGE: OpenStage = 'WARM'

/** The stage to write: a valid open stage, else the default. A closed stage is never accepted. */
export function openStage(value: unknown): OpenStage {
  const v = String(value ?? '').trim().toLowerCase()
  return OPEN_STAGES.find(s => s.value.toLowerCase() === v || s.label.toLowerCase() === v)?.value ?? DEFAULT_STAGE
}
