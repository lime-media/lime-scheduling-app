/**
 * Reading a reply that may have come through a server-side fallback
 * (lib/claudeReply.ts). Run with: npm test
 */
import Anthropic from '@anthropic-ai/sdk'
import { defer, eq, section } from './harness'
import { callBeforeDeadline, servedBlocks, servedText, servedToolUses } from '@/lib/claudeReply'

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Anthropic.Beta.BetaContentBlock
const tool = (name: string) => ({ type: 'tool_use', id: name, name, input: {} }) as unknown as Anthropic.Beta.BetaContentBlock
const fallback = { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } as unknown as Anthropic.Beta.BetaContentBlock

section('Claude replies through a server-side fallback')
eq('no fallback: the whole reply', servedText([text('Hi'), text('there')]), 'Hi\n\nthere')
eq('fallback first (declined before any output): the fallback model\'s reply', servedText([fallback, text('Answer')]), 'Answer')
eq('anything before the last fallback block is not read', servedText([text('declined partial'), fallback, text('Answer')]), 'Answer')
eq('nor are tool calls before it', servedToolUses([tool('place_hold'), fallback, tool('check_availability')]).map(t => t.name), ['check_availability'])
eq('several fallbacks: after the last', servedBlocks([fallback, text('a'), fallback, text('b')]).length, 1)

section('Claude calls before a deadline')
{
  const run = async (errors: Error[], deadlineIn: number) => {
    let calls = 0
    const seen: number[] = []
    try {
      await callBeforeDeadline(Date.now() + deadlineIn, async opts => {
        seen.push(opts.timeout)
        const e = errors[calls++]
        if (e) throw e
        return 'ok'
      })
      return { result: 'ok', calls, seen }
    } catch (err) {
      return { result: (err as Error).constructor.name, calls, seen }
    }
  }
  const dropped = () => new Anthropic.APIConnectionError({ message: 'reset' })
  const timedOut = () => new Anthropic.APIConnectionTimeoutError()
  defer((async () => {
    eq('a dropped connection is retried, then answers', (await run([dropped()], 200_000)).calls, 2)
    eq('a timeout is not retried', (await run([timedOut()], 200_000)).result, 'APIConnectionTimeoutError')
    eq('at most two retries', (await run([dropped(), dropped(), dropped()], 200_000)).calls, 3)
    eq('no retry with under 30s left', (await run([dropped()], 20_000)).calls, 1)
    eq('each attempt gets no more than the time left', (await run([], 100_000)).seen[0] <= 100_000, true)
  })())
}
