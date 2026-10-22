/**
 * Reading a reply that may have come through a server-side fallback
 * (lib/claudeReply.ts). Run with: npm test
 */
import type Anthropic from '@anthropic-ai/sdk'
import { eq, section } from './harness'
import { servedBlocks, servedText, servedToolUses } from '@/lib/claudeReply'

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Anthropic.Beta.BetaContentBlock
const tool = (name: string) => ({ type: 'tool_use', id: name, name, input: {} }) as unknown as Anthropic.Beta.BetaContentBlock
const fallback = { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } as unknown as Anthropic.Beta.BetaContentBlock

section('Claude replies through a server-side fallback')
eq('no fallback: the whole reply', servedText([text('Hi'), text('there')]), 'Hi\n\nthere')
eq('fallback first (declined before any output): the fallback model\'s reply', servedText([fallback, text('Answer')]), 'Answer')
eq('anything before the last fallback block is not read', servedText([text('declined partial'), fallback, text('Answer')]), 'Answer')
eq('nor are tool calls before it', servedToolUses([tool('place_hold'), fallback, tool('check_availability')]).map(t => t.name), ['check_availability'])
eq('several fallbacks: after the last', servedBlocks([fallback, text('a'), fallback, text('b')]).length, 1)
