'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { AISidebar, type ConvSummary } from '@/components/AISidebar'

// ── Types ─────────────────────────────────────────────────────────────────────

type Message = {
  role: 'user' | 'assistant'
  content: string
  isAction?: boolean
  actionOk?: boolean
}

type ParsedTruck = { number: string; location: string; distance: string }
type ParsedEvent = { name: string; dates: string; trucks: ParsedTruck[]; note?: string }

// ── Event block parser ────────────────────────────────────────────────────────

function parseAIResponse(text: string): { events: ParsedEvent[]; plainText: string } {
  const events: ParsedEvent[] = []
  const plainParts: string[]  = []
  const eventRE = /\[EVENT\]([\s\S]*?)\[\/EVENT\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = eventRE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim()
    if (before) plainParts.push(before)
    lastIndex = match.index + match[0].length

    const ev: ParsedEvent = { name: '', dates: '', trucks: [] }
    for (const line of match[1].split('\n')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const key = line.slice(0, colon).trim()
      const val = line.slice(colon + 1).trim()
      if (key === 'name')       ev.name  = val
      else if (key === 'dates') ev.dates = val
      else if (key === 'note')  ev.note  = val
      else if (key === 'truck') {
        const p = val.split('|').map((s) => s.trim())
        ev.trucks.push({ number: p[0] ?? '', location: p[1] ?? '', distance: p[2] ?? '' })
      }
    }
    if (ev.name || ev.trucks.length > 0) events.push(ev)
  }

  const after = text.slice(lastIndex).trim()
  if (after) plainParts.push(after)
  return { events, plainText: plainParts.join('\n\n') }
}

// ── Event card ────────────────────────────────────────────────────────────────

function EventCard({ ev }: { ev: ParsedEvent }) {
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white mb-3">
      <div className="px-4 pt-4 pb-3 border-b border-gray-100">
        <div className="text-[15px] font-semibold text-gray-900">{ev.name}</div>
        {ev.dates && <div className="text-sm text-gray-500 mt-0.5">{ev.dates}</div>}
      </div>
      {ev.trucks.length > 0 && (
        <div className="px-4 pt-3 pb-1">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">
            Assigned Trucks
          </div>
          <div className="divide-y divide-gray-100">
            {ev.trucks.map((t, i) => (
              <div key={i} className="flex items-center py-2">
                <span className="text-sm font-bold text-gray-900 w-14 flex-shrink-0">{t.number}</span>
                <span className="text-sm text-gray-600 flex-1">{t.location}</span>
                {t.distance && <span className="text-sm text-gray-400 flex-shrink-0">{t.distance}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {ev.note && (
        <div className="mx-4 mb-4 mt-2 bg-gray-50 rounded-lg px-3 py-2.5 flex gap-2">
          <span className="text-gray-400 flex-shrink-0 mt-px">&#9651;</span>
          <span className="text-sm text-gray-600 leading-snug">{ev.note}</span>
        </div>
      )}
    </div>
  )
}

// ── Assistant message renderer ────────────────────────────────────────────────

function AssistantMessage({ content }: { content: string }) {
  const { events, plainText } = parseAIResponse(content)
  return (
    <div className="w-full">
      {plainText && (
        <div className={`text-sm text-gray-800 leading-relaxed whitespace-pre-wrap ${events.length > 0 ? 'mb-3' : ''}`}>
          {plainText}
        </div>
      )}
      {events.map((ev, i) => <EventCard key={i} ev={ev} />)}
    </div>
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WELCOME_CONTENT =
  "Hi! I'm your Lime Media Scheduling Assistant. Ask me about truck availability, holds, conflicts, or anything related to the schedule."

const SUGGESTED = [
  'Which trucks are available this week?',
  'How many trucks are in Dallas?',
  'Are there any scheduling conflicts?',
  'Which trucks are on hold right now?',
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function AIPage() {
  const { data: session } = useSession()

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [conversations, setConversations]               = useState<ConvSummary[]>([])
  const [convsLoading, setConvsLoading]                 = useState(true)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [messages, setMessages]                         = useState<Message[]>([])
  const [input, setInput]                               = useState('')
  const [loading, setLoading]                           = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Open sidebar by default on desktop
  useEffect(() => {
    if (window.innerWidth >= 768) setSidebarOpen(true)
  }, [])

  // ── Fetch conversation list ────────────────────────────────────────────────
  const fetchConversations = useCallback(async (): Promise<ConvSummary[]> => {
    try {
      const res = await fetch('/api/conversations')
      if (res.ok) {
        const data = await res.json()
        const convs: ConvSummary[] = data.conversations ?? []
        setConversations(convs)
        return convs
      }
    } catch (err) {
      console.error('Failed to fetch conversations:', err)
    }
    return []
  }, [])

  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false)
    }
  }, [])

  // ── Load a specific conversation ──────────────────────────────────────────
  const loadConversation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`)
      if (res.ok) {
        const data = await res.json()
        const msgs: Message[] = (data.messages ?? []).map(
          (m: { role: string; content: string }) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })
        )
        setMessages(msgs)
        setActiveConversationId(id)
        closeSidebarOnMobile()
      }
    } catch (err) {
      console.error('Failed to load conversation:', err)
    }
  }, [closeSidebarOnMobile])

  // ── On mount: fetch conversations, auto-load most recent ──────────────────
  useEffect(() => {
    ;(async () => {
      setConvsLoading(true)
      const convs = await fetchConversations()
      if (convs.length > 0) await loadConversation(convs[0].id)
      setConvsLoading(false)
    })()
  }, [fetchConversations, loadConversation])

  // ── New Chat ──────────────────────────────────────────────────────────────
  const startNewChat = useCallback(() => {
    setActiveConversationId(null)
    setMessages([])
    setInput('')
    inputRef.current?.focus()
  }, [])

  // ── Delete conversation ───────────────────────────────────────────────────
  const deleteConversation = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      if (!confirm('Delete this conversation?')) return
      try {
        await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
        const updated = await fetchConversations()
        if (id === activeConversationId) {
          if (updated.length > 0) {
            await loadConversation(updated[0].id)
          } else {
            startNewChat()
          }
        }
      } catch (err) {
        console.error('Failed to delete conversation:', err)
      }
    },
    [activeConversationId, fetchConversations, loadConversation, startNewChat]
  )

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      if (!content || loading) return

      const userMsg: Message = { role: 'user', content }
      const nextMessages     = [...messages, userMsg]
      setMessages(nextMessages)
      setInput('')
      setLoading(true)

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            history: messages.filter((m) => !m.isAction).slice(-10),
            conversation_id: activeConversationId,
          }),
        })

        const data = await res.json()

        if (res.ok) {
          const msgs: Message[] = [
            ...nextMessages,
            { role: 'assistant', content: data.reply },
          ]
          if (data.actionResult) {
            msgs.push({
              role: 'assistant',
              content: data.actionResult.message,
              isAction: true,
              actionOk: data.actionResult.success,
            })
          }
          setMessages(msgs)
          if (data.conversation_id) setActiveConversationId(data.conversation_id)
          fetchConversations()
        } else {
          setMessages([
            ...nextMessages,
            { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' },
          ])
        }
      } catch {
        setMessages([
          ...nextMessages,
          { role: 'assistant', content: 'Network error. Please check your connection.' },
        ])
      } finally {
        setLoading(false)
      }
    },
    [input, loading, messages, activeConversationId, fetchConversations]
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const isBlank = activeConversationId === null && messages.length === 0

  return (
    <div className="flex h-dvh bg-gray-50 overflow-hidden">

      {/* Mobile backdrop — tap to close sidebar */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — fixed overlay on mobile, normal flow on desktop */}
      <div
        className={`
          fixed inset-y-0 left-0 z-50 transition-transform duration-200
          md:relative md:inset-auto md:z-auto md:translate-x-0 md:flex-shrink-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <AISidebar
          sidebarOpen={sidebarOpen}
          conversations={conversations}
          convsLoading={convsLoading}
          activeConversationId={activeConversationId}
          onNewChat={() => { startNewChat(); closeSidebarOnMobile() }}
          onSelectConversation={loadConversation}
          onDeleteConversation={deleteConversation}
          session={session}
        />
      </div>

      {/* ── Main chat area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 flex-shrink-0">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="p-1.5 rounded hover:bg-gray-100 transition-colors text-gray-500"
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <h1 className="font-semibold text-gray-900">AI Scheduling Assistant</h1>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">

            {/* Blank state: welcome bubble + suggested questions */}
            {isBlank && (
              <>
                <div className="flex justify-start">
                  <div className="w-7 h-7 rounded-full bg-green-700 flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5">
                    AI
                  </div>
                  <div className="max-w-[90%] sm:max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed bg-white border border-gray-200 text-gray-800 shadow-sm">
                    {WELCOME_CONTENT}
                  </div>
                </div>
                <div className="pt-2 pb-4">
                  <p className="text-center text-sm text-gray-400 mb-4">
                    Ask anything about the Lime Media truck schedule
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {SUGGESTED.map((q) => (
                      <button
                        key={q}
                        onClick={() => sendMessage(q)}
                        className="text-left px-4 py-3 rounded-xl border border-gray-200 bg-white hover:border-green-400 hover:bg-green-50 text-sm text-gray-700 transition-colors shadow-sm"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Message bubbles */}
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'assistant' && !msg.isAction && (
                  <div className="w-7 h-7 rounded-full bg-green-700 flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5">
                    AI
                  </div>
                )}
                {msg.isAction && <div className="w-7 h-7 flex-shrink-0 mr-2 mt-0.5" />}

                {msg.role === 'user' ? (
                  <div className="max-w-[85%] sm:max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm bg-green-700 text-white leading-relaxed">
                    {msg.content}
                  </div>
                ) : msg.isAction ? (
                  <div className={`max-w-[90%] sm:max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm font-medium leading-relaxed border ${
                    msg.actionOk
                      ? 'bg-green-50 text-green-800 border-green-200'
                      : 'bg-red-50 text-red-800 border-red-200'
                  }`}>
                    <span className="mr-1">{msg.actionOk ? '✓' : '✗'}</span>
                    {msg.content}
                  </div>
                ) : (
                  <div className="w-full">
                    <AssistantMessage content={msg.content} />
                  </div>
                )}
              </div>
            ))}

            {/* Typing indicator */}
            {loading && (
              <div className="flex justify-start">
                <div className="w-7 h-7 rounded-full bg-green-700 flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0">
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

        {/* Input bar */}
        <div className="flex-shrink-0 bg-white border-t border-gray-200 px-4 py-3">
          <div className="max-w-3xl mx-auto flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about availability, holds, conflicts…"
              rows={2}
              className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base sm:text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors flex-shrink-0 h-[46px]"
            >
              Send
            </button>
          </div>
          <p className="max-w-3xl mx-auto text-xs text-gray-400 mt-1.5 hidden sm:block">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  )
}
