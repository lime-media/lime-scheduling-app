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

  const [sidebarOpen, setSidebarOpen]                   = useState(true)
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
      }
    } catch (err) {
      console.error('Failed to load conversation:', err)
    }
  }, [])

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
    <div className="flex h-screen bg-gray-50 overflow-hidden">

      <AISidebar
        sidebarOpen={sidebarOpen}
        conversations={conversations}
        convsLoading={convsLoading}
        activeConversationId={activeConversationId}
        onNewChat={startNewChat}
        onSelectConversation={loadConversation}
        onDeleteConversation={deleteConversation}
        session={session}
      />

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
                  <div className="max-w-[80%] rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed bg-white border border-gray-200 text-gray-800 shadow-sm">
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
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                    msg.isAction
                      ? msg.actionOk
                        ? 'bg-green-50 text-green-800 border border-green-200 rounded-tl-sm font-medium'
                        : 'bg-red-50 text-red-800 border border-red-200 rounded-tl-sm font-medium'
                      : msg.role === 'user'
                      ? 'bg-green-700 text-white rounded-tr-sm'
                      : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
                  }`}
                >
                  {msg.isAction && <span className="mr-1">{msg.actionOk ? '✓' : '✗'}</span>}
                  {msg.content}
                </div>
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
              className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors flex-shrink-0 h-[46px]"
            >
              Send
            </button>
          </div>
          <p className="max-w-3xl mx-auto text-xs text-gray-400 mt-1.5">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  )
}
