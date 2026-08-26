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

type Tier = 'Good' | 'Better' | 'Best'

type Message = {
  role: 'user' | 'assistant'
  content: string
  isAction?: boolean
  actionOk?: boolean
  quoteCard?: QuoteCardData
  // Set once a client clicks a pricing card on this message's quote — locks the card so it
  // can't be clicked again (each click submits a real hold request).
  holdRequestedTier?: Tier
}

type Intent = 'ask' | 'quote' | 'hold'

type StructuredParams = {
  intent: Intent
  market?: string
  start_date?: string
  end_date?: string
  truck_count?: number
  tier_preference?: string
}

// Market/dates/trucks from the most recent successful quote — reused when a pricing card is
// clicked, so placing a hold never re-asks for anything already given.
type QuoteFields = Pick<StructuredParams, 'market' | 'start_date' | 'end_date' | 'truck_count'>

type QuoteForm = {
  market: string
  start_date: string
  end_date: string
  truck_count: number | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUGGESTED = [
  'Tell me about the holds we have placed',
  'Is a truck available in Dallas this month?',
]

function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// Quote Card Component — each tier is a real button. Clicking one places a hold at that
// price immediately (no separate Hold step) unless the card is locked (Best, when the
// campaign doesn't qualify) or this specific quote already had a hold placed from it.
// ---------------------------------------------------------------------------

function QuoteCard({
  data,
  holdRequestedTier,
  disabled,
  onHold,
}: {
  data: QuoteCardData
  holdRequestedTier?: Tier
  disabled: boolean
  onHold: (tier: Tier) => void
}) {
  const tiers: { name: Tier; total: number; desc: string; includes: string[]; available: boolean; color: string; badge: string }[] = [
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

      {holdRequestedTier ? (
        <p className="text-xs text-green-700 font-medium mb-2 px-1">
          &#10003; Hold requested at the {holdRequestedTier} tier — see the confirmation below.
        </p>
      ) : (
        <p className="text-xs text-gray-500 mb-2 px-1">
          Click a plan below to place a hold at that price — no extra steps.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {tiers.map((tier) => {
          const isChosen = holdRequestedTier === tier.name
          const clickable = tier.available && !disabled
          return (
            <button
              key={tier.name}
              type="button"
              onClick={() => clickable && onHold(tier.name)}
              disabled={!clickable}
              title={
                !tier.available ? 'Not available for this campaign'
                : holdRequestedTier ? 'A hold has already been requested for this quote'
                : `Place a hold at the ${tier.name} tier`
              }
              className={`text-left rounded-xl border-2 p-3 transition-all ${tier.color} ${!tier.available ? 'opacity-60' : ''} ${
                clickable ? 'hover:shadow-md hover:-translate-y-0.5 cursor-pointer' : 'cursor-not-allowed'
              } ${isChosen ? 'ring-2 ring-offset-1 ring-green-500' : ''} disabled:hover:shadow-none disabled:hover:translate-y-0`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full ${tier.badge}`}>
                  {tier.name}
                </span>
                {!tier.available && (
                  <span className="text-[10px] text-gray-500 font-medium">Locked</span>
                )}
                {isChosen && (
                  <span className="text-[10px] text-green-700 font-semibold">&#10003; Requested</span>
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
              {tier.available && !holdRequestedTier && (
                <p className="text-[10px] text-gray-400 mt-2 font-medium">Click to hold &rarr;</p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quote Box — always visible at the top of the page. The primary way a client interacts
// with the assistant: fill this in, hit Get Quote, then click a pricing card to hold.
// ---------------------------------------------------------------------------

function QuoteBox({
  form,
  onChange,
  onSubmit,
  disabled,
}: {
  form: QuoteForm
  onChange: (p: Partial<QuoteForm>) => void
  onSubmit: () => void
  disabled: boolean
}) {
  const complete = Boolean(form.market.trim() && form.start_date && form.end_date && form.truck_count && form.truck_count > 0)
  const inputClass = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent w-full'
  const labelClass = 'text-xs font-medium text-gray-600 mb-1'
  const requiredMark = <span className="text-red-500">&nbsp;*</span>

  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-5 sm:px-6 sm:py-6">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-base sm:text-lg font-bold text-gray-900">Get a quote</h2>
        <p className="text-xs sm:text-sm text-gray-500 mt-0.5 mb-4">
          Enter your campaign details — we&apos;ll check availability and price it out below.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <label className={labelClass}>Market{requiredMark}</label>
            <input
              type="text"
              placeholder="e.g. Dallas, TX"
              value={form.market}
              onChange={(e) => onChange({ market: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Start date{requiredMark}</label>
            <input
              type="date"
              value={form.start_date}
              min={todayStr()}
              onChange={(e) => onChange({ start_date: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>End date{requiredMark}</label>
            <input
              type="date"
              value={form.end_date}
              min={form.start_date || todayStr()}
              onChange={(e) => onChange({ end_date: e.target.value })}
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
              value={form.truck_count ?? ''}
              onChange={(e) => onChange({ truck_count: e.target.value ? parseInt(e.target.value, 10) : undefined })}
              className={inputClass}
            />
          </div>
        </div>
        <button
          onClick={onSubmit}
          disabled={disabled || !complete}
          title={!complete ? 'Fill in market, start date, end date, and trucks to continue' : undefined}
          className="mt-4 w-full sm:w-auto bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-6 py-2.5 text-sm font-semibold transition-colors"
        >
          Get Quote
        </button>
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
  const [quoteForm, setQuoteForm] = useState<QuoteForm>({ market: '', start_date: '', end_date: '', truck_count: undefined })
  // Market/dates/trucks from the last successful quote — carried into a hold when a pricing
  // card is clicked, so the client is never asked to re-enter them.
  const [lastQuoteFields, setLastQuoteFields] = useState<QuoteFields | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const updateQuoteForm = useCallback((partial: Partial<QuoteForm>) => {
    setQuoteForm((prev) => ({ ...prev, ...partial }))
  }, [])

  // Shared core — posts one turn to the assistant and appends the exchange to the thread.
  // `typed` is the raw free-text the model actually sees (kept separate from `displayContent`,
  // the friendly chat-bubble text, so a synthetic sentence never sits alongside a structured
  // payload and reads as a second, duplicate request).
  const postToAssistant = useCallback(async (opts: {
    typed: string
    structuredPayload?: StructuredParams
    displayContent: string
  }) => {
    if (loading) return
    const userMsg: Message = { role: 'user', content: opts.displayContent }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/client/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message:    opts.typed,
          history:    nextMessages.slice(-10),
          structured: opts.structuredPayload,
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
    }
  }, [loading, messages])

  const submitQuote = useCallback(async () => {
    const { market, start_date, end_date, truck_count } = quoteForm
    if (loading || !market.trim() || !start_date || !end_date || !truck_count) return

    setLastQuoteFields({ market, start_date, end_date, truck_count })

    const parts = [
      `${truck_count} truck${truck_count === 1 ? '' : 's'}`,
      `in ${market}`,
      `${start_date} to ${end_date}`,
    ]
    await postToAssistant({
      typed: '',
      structuredPayload: { intent: 'quote', market, start_date, end_date, truck_count },
      displayContent: `Please quote this request.\n${parts.join(' · ')}`,
    })
  }, [loading, quoteForm, postToAssistant])

  const submitHold = useCallback(async (tier: Tier, messageIndex: number) => {
    if (loading || !lastQuoteFields) return

    // Lock this card immediately so a second click (or a slow response) can't submit twice.
    setMessages((prev) => prev.map((m, i) => (i === messageIndex ? { ...m, holdRequestedTier: tier } : m)))

    const { market, start_date, end_date, truck_count } = lastQuoteFields
    const parts = [
      truck_count ? `${truck_count} truck${truck_count === 1 ? '' : 's'}` : null,
      market ? `in ${market}` : null,
      start_date && end_date ? `${start_date} to ${end_date}` : null,
      `(${tier} tier)`,
    ].filter(Boolean)
    await postToAssistant({
      typed: '',
      structuredPayload: { intent: 'hold', ...lastQuoteFields, tier_preference: tier },
      displayContent: `Please place this hold.\n${parts.join(' · ')}`,
    })
  }, [loading, lastQuoteFields, postToAssistant])

  const sendAsk = useCallback(async (text?: string) => {
    const typed = (text ?? input).trim()
    if (loading || !typed) return
    await postToAssistant({ typed, displayContent: typed })
  }, [loading, input, postToAssistant])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendAsk()
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
          <QuoteBox form={quoteForm} onChange={updateQuoteForm} onSubmit={submitQuote} disabled={loading} />

          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
              {isBlank && (
                <>
                  <div className="flex justify-start">
                    <div className="w-7 h-7 rounded-full bg-[#1a3028] flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5">
                      AI
                    </div>
                    <div className="max-w-[90%] sm:max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed bg-white border border-gray-200 text-gray-800 shadow-sm">
                      {`Hi, I'm the Lime Media assistant for ${clientUser.companyName}. Fill in the quote box above for pricing and availability, or ask me anything about your hold requests below — I can only see your own account, never any other client's.`}
                    </div>
                  </div>
                  <div className="pt-2 pb-4">
                    <div className="grid grid-cols-1 gap-2">
                      {SUGGESTED.map((q) => (
                        <button
                          key={q}
                          onClick={() => sendAsk(q)}
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
                        <QuoteCard
                          data={msg.quoteCard}
                          holdRequestedTier={msg.holdRequestedTier}
                          disabled={loading}
                          onHold={(tier) => submitHold(tier, i)}
                        />
                      )}
                      <div className={`rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm font-medium leading-relaxed border ${
                        msg.actionOk
                          ? 'bg-green-50 text-green-800 border-green-200'
                          : 'bg-red-50 text-red-800 border-red-200'
                      }`}>
                        <span className="mr-1">{msg.actionOk ? '✓' : '✗'}</span>
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
            <div className="max-w-2xl mx-auto flex gap-2 items-end">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your hold requests or truck availability…"
                rows={2}
                className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base sm:text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
              <button
                onClick={() => sendAsk()}
                disabled={loading || !input.trim()}
                className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors flex-shrink-0 h-[46px]"
              >
                Send
              </button>
            </div>
            <p className="max-w-2xl mx-auto text-xs text-gray-400 mt-1.5 hidden sm:block">
              Press Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
