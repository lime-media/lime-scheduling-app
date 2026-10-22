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

import type Anthropic from '@anthropic-ai/sdk'

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
