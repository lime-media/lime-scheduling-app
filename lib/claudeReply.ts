/**
 * Reading a Claude reply that may have come through a server-side fallback
 * (fallbacks: 'default'): the content of the model that served it.
 *
 * A model that declines is replaced server-side, and the reply carries a
 * `fallback` block where it switched. On these non-streaming calls the API
 * leaves out the declined model's partial output, so normally nothing precedes
 * the block; reading only what follows the last one also holds if it didn't.
 * The whole turn is still echoed back unchanged (the API ignores the block).
 */

import Anthropic from '@anthropic-ai/sdk'

/** The blocks of the model that served the reply: everything after the last fallback block. */
export function servedBlocks(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const last = content.map(b => b.type).lastIndexOf('fallback')
  return last === -1 ? content : content.slice(last + 1)
}

/** The served reply's text, joined. */
export function servedText(content: Anthropic.Beta.BetaContentBlock[]): string {
  return servedBlocks(content)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
    .trim()
}

/** The served reply's tool calls. */
export function servedToolUses(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaToolUseBlock[] {
  return servedBlocks(content).filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
}

/** Below this much time left, a quick failure isn't retried: the answer must still be saved. */
const MIN_RETRY_TIME_MS = 30_000

/**
 * A model call that must finish by `deadlineAt` (ms since epoch). Each attempt
 * gets only the time left. A quick transient failure (429, 5xx including 529
 * overloaded, a dropped connection) is retried, up to twice, while at least
 * MIN_RETRY_TIME_MS remains; a timeout is not (the time is used up). The SDK's
 * own retries are off, since they don't know the deadline.
 */
export async function callBeforeDeadline<T>(deadlineAt: number, call: (opts: { timeout: number; maxRetries: 0 }) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call({ timeout: Math.max(1_000, deadlineAt - Date.now()), maxRetries: 0 })
    } catch (err) {
      const transient = err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError
        || (err instanceof Anthropic.APIConnectionError && !(err instanceof Anthropic.APIConnectionTimeoutError))
      if (!transient || attempt >= 2 || deadlineAt - Date.now() < MIN_RETRY_TIME_MS) throw err
      await new Promise(r => setTimeout(r, 1_000 * (attempt + 1)))
    }
  }
}
