'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ClientHeader } from '@/components/ClientHeader'
import { useClientAuth, hasAiAssistantAccess } from '@/lib/useClientAuth'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuoteCardData = {
  truckCount: number
  days: number
  truckDays: number
  dailyRate: number
  marketSizeTier: { id: number; label: string }
  good:   { total: number; description: string }
  better: { total: number; description: string; includes: string[] }
  best:   { total: number; description: string; includes: string[]; available: boolean; reason?: string }
  pricingBasis: string
}

type Message = {
  role: 'user' | 'assistant'
  content: string
  isAction?: boolean
  actionOk?: boolean
  quoteCard?: QuoteCardData
}

type InputMode = 'ask' | 'quote' | 'hold'

type StructuredParams = {
  intent: InputMode
  market?: string
  start_date?: string
  end_date?: string
  truck_count?: number
  tier_preference?: string
}

// Market/dates/trucks carried over from the last Quote request — Hold mode reuses these
// instead of asking the client to re-enter them.
type QuoteFields = Pick<StructuredParams, 'market' | 'start_date' | 'end_date' | 'truck_count'>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUGGESTED = [
  'Tell me about the holds we have placed',
  'Can I get a truck in Dallas this month?',
]

const TIER_OPTIONS = [
  { value: '', label: 'No preference' },
  { value: 'Good', label: 'Good — base media' },
  { value: 'Better', label: 'Better — with digital' },
  { value: 'Best', label: 'Best — full measurement' },
]

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// Quote Card Component
// ---------------------------------------------------------------------------

function QuoteCard({ data }: { data: QuoteCardData }) {
  const tiers = [
    {
      name: 'Good',
      total: data.good.total,
      desc: data.good.description,
      includes: ['Base media'],
      available: true,
      color: 'border-green-300 bg-green-50',
      badge: 'bg-green-600',
    },
    {
      name: 'Better',
      total: data.better.total,
      desc: data.better.description,
      includes: ['Base media', ...data.better.includes],
      available: true,
      color: 'border-blue-300 bg-blue-50',
      badge: 'bg-blue-600',
    },
    {
      name: 'Best',
      total: data.best.total,
      desc: data.best.description,
      includes: ['Base media', ...data.best.includes],
      available: data.best.available,
      color: data.best.available ? 'border-purple-300 bg-purple-50' : 'border-gray-200 bg-gray-50',
      badge: data.best.available ? 'bg-purple-600' : 'bg-gray-400',
    },
  ]

  return (
    <div className="w-full max-w-[95%] sm:max-w-[90%]">
      <div className="text-xs text-gray-500 mb-2 px-1">
        {data.truckCount} truck{data.truckCount === 1 ? '' : 's'} &times; {data.days} day{data.days === 1 ? '' : 's'} = {data.truckDays} truck-day{data.truckDays === 1 ? '' : 's'} &middot; {fmtMoney(data.dailyRate)}/truck-day
        {data.pricingBasis !== 'standard' ? ' · negotiated rate' : ''}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`rounded-xl border-2 p-3 transition-all ${tier.color} ${!tier.available ? 'opacity-60' : ''}`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full ${tier.badge}`}>
                {tier.name}
              </span>
              {!tier.available && (
                <span className="text-[10px] text-gray-500 font-medium">Locked</span>
              )}
            </div>
            <div className={`text-lg font-bold ${tier.available ? 'text-gray-900' : 'text-gray-400'}`}>
              {fmtMoney(tier.total)}
            </div>
            <div className="text-xs text-gray-500 mt-0.5 mb-2">{tier.desc}</div>
            <ul className="space-y-0.5">
              {tier.includes.map((item) => (
                <li key={item} className="text-xs text-gray-600 flex items-start gap-1">
                  <span className="text-green-600 mt-0.5 flex-shrink-0">&#10003;</span>
                  {item}
                </li>
              ))}
            </ul>
            {!tier.available && tier.name === 'Best' && data.best.reason && (
              <p className="text-[10px] text-gray-400 mt-2 leading-tight">{data.best.reason}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Structured Input Panel
// ---------------------------------------------------------------------------

function StructuredInputPanel({
  mode,
  params,
  onChange,
}: {
  mode: InputMode
  params: StructuredParams
  onChange: (p: Partial<StructuredParams>) => void
}) {
  if (mode === 'ask') return null

  const inputClass = 'border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
  const labelClass = 'text-xs font-medium text-gray-500 mb-0.5'

  // Hold mode reuses the market/dates/trucks from the Quote request that unlocked it — the
  // client already entered those once, right above. All Hold needs here is tier preference.
  if (mode === 'hold') {
    const truckLabel = params.truck_count ? `${params.truck_count} truck${params.truck_count === 1 ? '' : 's'}` : '—'
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
        <div className="text-xs text-gray-500 mb-2">
          Holding {truckLabel} in {params.market || '—'} &middot; {params.start_date || '—'} to {params.end_date || '—'}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="col-span-2 sm:col-span-1">
            <label className={labelClass}>Tier preference</label>
            <select
              value={params.tier_preference ?? ''}
              onChange={(e) => onChange({ tier_preference: e.target.value || undefined })}
              className={inputClass}
            >
              {TIER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    )
  }

  // Quote mode — market, both dates, and truck count are the entire submission, so mark
  // them required.
  const requiredMark = <span className="text-red-500">&nbsp;*</span>

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="col-span-2 sm:col-span-1">
          <label className={labelClass}>Market{requiredMark}</label>
          <input
            type="text"
            placeholder="e.g. Dallas, TX"
            value={params.market ?? ''}
            onChange={(e) => onChange({ market: e.target.value })}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Start date{requiredMark}</label>
          <input
            type="date"
            value={params.start_date ?? ''}
            min={todayStr()}
            onChange={(e) => onChange({ start_date: e.target.value })}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>End date{requiredMark}</label>
          <input
            type="date"
            value={params.end_date ?? ''}
            min={params.start_date || todayStr()}
            onChange={(e) => onChange({ end_date: e.target.value })}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Trucks{requiredMark}</label>
          <input
            type="number"
            min={1}
            max={50}
            placeholder="1"
            value={params.truck_count ?? ''}
            onChange={(e) => onChange({ truck_count: e.target.value ? parseInt(e.target.value, 10) : undefined })}
            required
            className={inputClass}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ClientAiPage() {
  const { clientUser, authChecked } = useClientAuth()

  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [mode,     setMode]     = useState<InputMode>('ask')
  const [structured, setStructured] = useState<StructuredParams>({ intent: 'ask' })
  // Market/dates/trucks from the last Quote request — reused when switching into Hold mode
  // so the client doesn't have to re-enter them.
  const [lastQuoteFields, setLastQuoteFields] = useState<QuoteFields | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  // Track whether a quote exists in the conversation — Hold mode requires it
  const hasQuote = messages.some((m) => m.quoteCard != null)

  // Quote mode is field-driven — market, both dates, and a truck count are all required,
  // and the client shouldn't have to type anything into the free-text box to submit.
  const quoteFieldsComplete = Boolean(
    structured.market?.trim() &&
    structured.start_date &&
    structured.end_date &&
    structured.truck_count && structured.truck_count > 0
  )

  // Hold mode is likewise field-driven — market/dates/trucks are carried over from the last
  // quote (see switchMode/lastQuoteFields) and tier preference defaults to "No preference",
  // so notes are optional and Send shouldn't require typing anything either.
  const holdFieldsComplete = Boolean(
    structured.market?.trim() &&
    structured.start_date &&
    structured.end_date &&
    structured.truck_count && structured.truck_count > 0
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const updateStructured = useCallback((partial: Partial<StructuredParams>) => {
    setStructured((prev) => ({ ...prev, ...partial }))
  }, [])

  const switchMode = useCallback((newMode: InputMode) => {
    if (newMode === 'hold' && !hasQuote) return // can't enter Hold mode without a quote
    setMode(newMode)
    setStructured((prev) =>
      newMode === 'hold' && lastQuoteFields
        // Carry over market/dates/trucks from the last Quote request instead of asking again.
        ? { intent: 'hold', ...lastQuoteFields, tier_preference: prev.tier_preference }
        : { ...prev, intent: newMode }
    )
  }, [hasQuote, lastQuoteFields])

  const sendMessage = useCallback(async (text?: string) => {
    if (loading) return

    // Quote and Hold modes are field-driven — the client can hit Send with the fields above
    // filled in and nothing typed. Ask mode still needs typed text.
    const typed = (text ?? input).trim()
    if (mode === 'quote') {
      if (!quoteFieldsComplete) return
      // Remember these fields so Hold mode can reuse them without asking again.
      setLastQuoteFields({
        market:      structured.market,
        start_date:  structured.start_date,
        end_date:    structured.end_date,
        truck_count: structured.truck_count,
      })
    } else if (mode === 'hold') {
      if (!holdFieldsComplete) return
    } else if (!typed) {
      return
    }
    const content = typed || (mode === 'quote' ? 'Please quote this request.' : mode === 'hold' ? 'Please place this hold.' : '')

    // Build the structured payload if in quote/hold mode with filled fields
    const hasStructuredFields = mode !== 'ask' && (structured.market || structured.start_date || structured.truck_count)
    const structuredPayload = hasStructuredFields ? { ...structured, intent: mode } : undefined

    // Show the user message with structured context if present
    let displayContent = content
    if (structuredPayload?.market || structuredPayload?.start_date) {
      const parts: string[] = []
      if (structuredPayload.truck_count) parts.push(`${structuredPayload.truck_count} truck${structuredPayload.truck_count === 1 ? '' : 's'}`)
      if (structuredPayload.market) parts.push(`in ${structuredPayload.market}`)
      if (structuredPayload.start_date && structuredPayload.end_date) parts.push(`${structuredPayload.start_date} to ${structuredPayload.end_date}`)
      else if (structuredPayload.start_date) parts.push(`starting ${structuredPayload.start_date}`)
      if (structuredPayload.tier_preference) parts.push(`(${structuredPayload.tier_preference} tier)`)
      if (parts.length > 0) displayContent = `${content}\n${parts.join(' · ')}`
    }

    const userMsg: Message = { role: 'user', content: displayContent }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/client/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          history: nextMessages.slice(-10),
          structured: structuredPayload,
        }),
      })
      const data = await res.json()

      if (res.ok) {
        const msgs: Message[] = [...nextMessages, { role: 'assistant', content: data.reply }]
        if (data.actionResult) {
          msgs.push({
            role:     'assistant',
            content:  data.actionResult.message,
            isAction: true,
            actionOk: data.actionResult.success,
            quoteCard: data.actionResult.quoteCard,
          })
        }
        setMessages(msgs)
      } else {
        setMessages([...nextMessages, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }])
      }
    } catch {
      setMessages([...nextMessages, { role: 'assistant', content: 'Network error. Please check your connection.' }])
    } finally {
      setLoading(false)
      // Reset structured fields after send, keep mode — but Hold mode keeps its carried-over
      // market/dates/trucks from the last quote, only the tier preference clears.
      setStructured(
        mode === 'hold' && lastQuoteFields
          ? { intent: 'hold', ...lastQuoteFields }
          : { intent: mode }
      )
    }
  }, [input, loading, messages, mode, structured, quoteFieldsComplete, holdFieldsComplete, lastQuoteFields])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  if (!authChecked) return null

  if (!clientUser) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh text-center p-4">
        <div className="text-5xl mb-4">&#128274;</div>
        <p className="text-gray-600 font-medium">Log in to use the assistant</p>
        <Link href="/client/login" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
          Log in
        </Link>
      </div>
    )
  }

  if (!hasAiAssistantAccess(clientUser)) {
    return (
      <div className="flex flex-col h-dvh bg-gray-50 overflow-hidden">
        <ClientHeader clientUser={clientUser} authChecked={authChecked} />
        <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
          <div className="text-5xl mb-4">&#128679;</div>
          <p className="text-gray-600 font-medium">The assistant isn&apos;t available on your account yet.</p>
          <Link href="/client" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
            Back to Schedule
          </Link>
        </div>
      </div>
    )
  }

  const isBlank = messages.length === 0

  return (
    <div className="flex flex-col h-dvh bg-gray-50 overflow-hidden">
      <ClientHeader clientUser={clientUser} authChecked={authChecked} />

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-[#94ce3a] rounded-full animate-pulse" />
              <h1 className="font-semibold text-gray-900">Assistant</h1>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
              {isBlank && (
                <>
                  <div className="flex justify-start">
                    <div className="w-7 h-7 rounded-full bg-[#1a3028] flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5">
                      AI
                    </div>
                    <div className="max-w-[90%] sm:max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed bg-white border border-gray-200 text-gray-800 shadow-sm">
                      {`Hi, I'm the Lime Media assistant for ${clientUser.companyName}. Ask me about your hold requests or truck availability — I can only see your own account, never any other client's.`}
                    </div>
                  </div>
                  <div className="pt-2 pb-4">
                    <div className="grid grid-cols-1 gap-2">
                      {SUGGESTED.map((q) => (
                        <button
                          key={q}
                          onClick={() => sendMessage(q)}
                          className="text-left px-4 py-3 rounded-xl border border-gray-200 bg-white hover:border-[#94ce3a] hover:bg-[#94ce3a]/10 text-sm text-gray-700 transition-colors shadow-sm"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && !msg.isAction && (
                    <div className="w-7 h-7 rounded-full bg-[#1a3028] flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5">
                      AI
                    </div>
                  )}
                  {msg.isAction && <div className="w-7 h-7 flex-shrink-0 mr-2 mt-0.5" />}

                  {msg.role === 'user' ? (
                    <div className="max-w-[85%] sm:max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm bg-[#1a3028] text-white leading-relaxed whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  ) : msg.isAction ? (
                    <div className="flex flex-col gap-2 max-w-[95%] sm:max-w-[90%]">
                      {msg.quoteCard && (
                        <QuoteCard data={msg.quoteCard} />
                      )}
                      <div className={`rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm font-medium leading-relaxed border ${
                        msg.actionOk
                          ? 'bg-green-50 text-green-800 border-green-200'
                          : 'bg-red-50 text-red-800 border-red-200'
                      }`}>
                        <span className="mr-1">{msg.actionOk ? '\u2713' : '\u2717'}</span>
                        {msg.content}
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-[90%] sm:max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed bg-white border border-gray-200 text-gray-800 shadow-sm">
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="flex justify-start">
                  <div className="w-7 h-7 rounded-full bg-[#1a3028] flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0">
                    AI
                  </div>
                  <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                    <div className="flex gap-1 items-center">
                      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                      <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          </div>

          <div className="flex-shrink-0 bg-white border-t border-gray-200 px-4 py-3">
            <div className="max-w-2xl mx-auto">
              {/* Mode pills — Hold requires a quote first */}
              <div className="flex gap-1.5 mb-2 items-center">
                {([
                  { key: 'ask',   label: 'Ask',   locked: false },
                  { key: 'quote', label: 'Quote', locked: false },
                  { key: 'hold',  label: 'Hold',  locked: !hasQuote },
                ] as const).map(({ key, label, locked }) => (
                  <button
                    key={key}
                    onClick={() => switchMode(key)}
                    disabled={locked}
                    title={locked ? 'Get a quote first' : undefined}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                      locked
                        ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
                        : mode === key
                        ? 'bg-[#1a3028] text-white shadow-sm'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {!hasQuote && (
                  <span className="text-[10px] text-gray-400 ml-1">Check availability &amp; quote before holding</span>
                )}
              </div>

              {/* Structured input fields for quote/hold modes */}
              <StructuredInputPanel mode={mode} params={structured} onChange={updateStructured} />

              {/* Text input + send */}
              <div className="flex gap-2 items-end">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    mode === 'quote' ? 'Add context or just hit Send with the fields above…'
                    : mode === 'hold' ? 'Optional notes for the hold request…'
                    : 'Ask about your hold requests or truck availability…'
                  }
                  rows={2}
                  className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base sm:text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
                <button
                  onClick={() => sendMessage()}
                  disabled={
                    loading ||
                    (mode === 'quote' ? !quoteFieldsComplete
                    : mode === 'hold'  ? !holdFieldsComplete
                    : !input.trim())
                  }
                  title={
                    mode === 'quote' && !quoteFieldsComplete ? 'Fill in market, start date, end date, and trucks to continue'
                    : mode === 'hold' && !holdFieldsComplete ? 'Get a quote first — market, dates, and trucks are missing'
                    : undefined
                  }
                  className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors flex-shrink-0 h-[46px]"
                >
                  Send
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1.5 hidden sm:block">
                {mode === 'quote' ? 'Market, start date, end date, and trucks are required' : 'Press Enter to send · Shift+Enter for new line'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
