'use client'

import { useState, useRef, useEffect } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Message = {
  role: 'user' | 'assistant'
  content: string
  isAction?: boolean
  actionOk?: boolean
}

type ParsedTruck = {
  number: string
  location: string
  distance: string
}

type ParsedEvent = {
  name: string
  dates: string
  trucks: ParsedTruck[]
  note?: string
}

type ParsedResponse = {
  events: ParsedEvent[]
  plainText: string
}

// ── Parser ────────────────────────────────────────────────────────────────────

function parseAIResponse(text: string): ParsedResponse {
  const events: ParsedEvent[] = []
  const plainParts: string[] = []
  const eventRE = /\[EVENT\]([\s\S]*?)\[\/EVENT\]/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = eventRE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim()
    if (before) plainParts.push(before)
    lastIndex = match.index + match[0].length

    const event: ParsedEvent = { name: '', dates: '', trucks: [] }

    for (const line of match[1].split('\n')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const key = line.slice(0, colon).trim()
      const val = line.slice(colon + 1).trim()

      if (key === 'name') event.name = val
      else if (key === 'dates') event.dates = val
      else if (key === 'note') event.note = val
      else if (key === 'truck') {
        const parts = val.split('|').map((p) => p.trim())
        event.trucks.push({
          number:   parts[0] ?? '',
          location: parts[1] ?? '',
          distance: parts[2] ?? '',
        })
      }
    }

    if (event.name || event.trucks.length > 0) events.push(event)
  }

  const after = text.slice(lastIndex).trim()
  if (after) plainParts.push(after)

  return { events, plainText: plainParts.join('\n\n') }
}

// ── Event Card ────────────────────────────────────────────────────────────────

function EventCard({ event }: { event: ParsedEvent }) {
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white mb-3">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100">
        <div className="text-[15px] font-semibold text-gray-900">{event.name}</div>
        {event.dates && (
          <div className="text-sm text-gray-500 mt-0.5">{event.dates}</div>
        )}
      </div>

      {/* Trucks */}
      {event.trucks.length > 0 && (
        <div className="px-4 pt-3 pb-1">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">
            Assigned Trucks
          </div>
          <div className="divide-y divide-gray-100">
            {event.trucks.map((t, i) => (
              <div key={i} className="flex items-center py-2">
                <span className="text-sm font-bold text-gray-900 w-14 flex-shrink-0">{t.number}</span>
                <span className="text-sm text-gray-600 flex-1">{t.location}</span>
                {t.distance && (
                  <span className="text-sm text-gray-400 flex-shrink-0">{t.distance}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Note */}
      {event.note && (
        <div className="mx-4 mb-4 mt-2 bg-gray-50 rounded-lg px-3 py-2.5 flex gap-2">
          <span className="text-gray-400 flex-shrink-0 mt-px">&#9651;</span>
          <span className="text-sm text-gray-600 leading-snug">{event.note}</span>
        </div>
      )}
    </div>
  )
}

// ── Message renderer ──────────────────────────────────────────────────────────

function AssistantMessage({ content }: { content: string }) {
  const parsed = parseAIResponse(content)
  const hasEvents = parsed.events.length > 0

  return (
    <div className="w-full">
      {parsed.plainText && (
        <div className={`text-sm text-gray-800 leading-relaxed whitespace-pre-wrap ${hasEvents ? 'mb-3' : ''}`}>
          {parsed.plainText}
        </div>
      )}
      {parsed.events.map((ev, i) => (
        <EventCard key={i} event={ev} />
      ))}
    </div>
  )
}

// ── Chat Panel ────────────────────────────────────────────────────────────────

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        "Hi! I'm your Lime Media Scheduling Assistant. Ask me about truck availability, holds, conflicts, or anything related to the schedule.",
    },
  ])
  const [input, setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: Message = { role: 'user', content: text }
    const newHistory = [...messages, userMsg]
    setMessages(newHistory)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: messages.slice(-10),
        }),
      })
      const data = await res.json()
      if (res.ok) {
        const msgs: Message[] = [
          ...newHistory,
          { role: 'assistant', content: data.reply },
        ]
        if (data.actionResult) {
          msgs.push({
            role:      'assistant',
            content:   data.actionResult.message,
            isAction:  true,
            actionOk:  data.actionResult.success,
          })
        }
        setMessages(msgs)
      } else {
        setMessages([
          ...newHistory,
          { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' },
        ])
      }
    } catch {
      setMessages([
        ...newHistory,
        { role: 'assistant', content: 'Network error. Please check your connection.' },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex flex-col h-full bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="bg-green-800 text-white px-4 py-3 flex items-center gap-2">
        <div className="w-2 h-2 bg-green-300 rounded-full animate-pulse" />
        <span className="font-semibold text-sm">AI Scheduling Assistant</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && !msg.isAction && (
              <div className="w-7 h-7 rounded-full bg-green-700 flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5">
                AI
              </div>
            )}
            {msg.isAction && (
              <div className="w-7 h-7 flex-shrink-0 mr-2 mt-0.5" />
            )}

            {msg.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm bg-green-700 text-white leading-relaxed">
                {msg.content}
              </div>
            ) : msg.isAction ? (
              <div
                className={`max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm font-medium leading-relaxed border ${
                  msg.actionOk
                    ? 'bg-green-50 text-green-800 border-green-200'
                    : 'bg-red-50 text-red-800 border-red-200'
                }`}
              >
                <span className="mr-1">{msg.actionOk ? '✓' : '✗'}</span>
                {msg.content}
              </div>
            ) : (
              <div className="max-w-[90%]">
                <AssistantMessage content={msg.content} />
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="w-7 h-7 rounded-full bg-green-700 flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0">
              AI
            </div>
            <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
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

      {/* Input */}
      <div className="border-t border-gray-200 p-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about availability, holds, conflicts..."
            rows={2}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="bg-green-700 hover:bg-green-800 text-white rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 flex-shrink-0"
          >
            Send
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1.5">Press Enter to send, Shift+Enter for new line</p>
      </div>
    </div>
  )
}
