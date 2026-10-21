/**
 * What a shared quote or booking function returns: the HTTP status and JSON
 * body its route sends. The route passes it straight through; the staff AI
 * chat hands the same body to the model as a tool result.
 */
export type CoreResult = { status: number; body: Record<string, unknown> }

/** Same shape as NextResponse.json(body, init), without the Response. */
export function reply(body: Record<string, unknown>, init?: { status: number }): CoreResult {
  return { status: init?.status ?? 200, body }
}
