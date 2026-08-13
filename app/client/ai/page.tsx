'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ClientAISidebar, type ClientConvSummary } from '@/components/ClientAISidebar'
import { useClientAuth } from '@/lib/useClientAuth'

type Message = { role: 'user' | 'assistant'; content: string; isAction?: boolean; actionOk?: boolean }

const SUGGESTED = [
  'Tell me about the holds we have placed',
  'Can I get a truck in Dallas this month?',
]

export default function ClientAiPage() {
  const { clientUser, authChecked } = useClientAuth()

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [conversations,        setConversations]        = useState<ClientConvSummary[]>([])
  const [convsLoading,         setConvsLoading]         = useState(true)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Open sidebar by default on desktop
  useEffect(() => {
    if (window.innerWidth >= 768) setSidebarOpen(true)
  }, [])

  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false)
  }, [])

  const fetchConversations = useCallback(async (): Promise<ClientConvSummary[]> => {
    try {
      const res = await fetch('/api/client/chat/conversations')
      if (res.ok) {
        const data = await res.json()
        const convs: ClientConvSummary[] = data.conversations ?? []
        setConversations(convs)
        return convs
      }
    } catch (err) {
      console.error('Failed to fetch conversations:', err)
    }
    return []
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/client/chat/conversations/${id}`)
      if (res.ok) {
        const data = await res.json()
        const msgs: Message[] = (data.messages ?? []).map((m: { role: string; content: string }) => ({
          role:    m.role as 'user' | 'assistant',
          content: m.content,
        }))
        setMessages(msgs)
        setActiveConversationId(id)
        closeSidebarOnMobile()
      }
    } catch (err) {
      console.error('Failed to load conversation:', err)
    }
  }, [closeSidebarOnMobile])

  // On mount (once logged in): fetch conversations, auto-load the most recent
  useEffect(() => {
    if (!authChecked || !clientUser) { setConvsLoading(false); return }
    ;(async () => {
      setConvsLoading(true)
      const convs = await fetchConversations()
      if (convs.length > 0) await loadConversation(convs[0].id)
      setConvsLoading(false)
    })()
  }, [authChecked, clientUser, fetchConversations, loadConversation])

  const startNewChat = useCallback(() => {
    setActiveConversationId(null)
    setMessages([])
    setInput('')
    inputRef.current?.focus()
  }, [])

  const deleteConversation = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this conversation?')) return
    try {
      await fetch(`/api/client/chat/conversations/${id}`, { method: 'DELETE' })
      const updated = await fetchConversations()
      if (id === activeConversationId) {
        if (updated.length > 0) await loadConversation(updated[0].id)
        else startNewChat()
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  }, [activeConversationId, fetchConversations, loadConversation, startNewChat])

  const sendMessage = useCallback(async (text?: string) => {
    const content = (text ?? input).trim()
    if (!content || loading) return

    const userMsg: Message = { role: 'user', content }
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
          conversation_id: activeConversationId,
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
          })
        }
        setMessages(msgs)
        if (data.conversation_id) setActiveConversationId(data.conversation_id)
        fetchConversations()
      } else {
        setMessages([...nextMessages, { role: 'assistant', content: 'Sorry, I encountered an error. Please try again.' }])
      }
    } catch {
      setMessages([...nextMessages, { role: 'assistant', content: 'Network error. Please check your connection.' }])
    } finally {
      setLoading(false)
    }
  }, [input, loading, messages, activeConversationId, fetchConversations])

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
        <div className="text-5xl mb-4">🔒</div>
        <p className="text-gray-600 font-medium">Log in to use the assistant</p>
        <Link href="/client/login" className="mt-4 bg-[#1a3028] text-white px-4 py-2 rounded-lg text-sm hover:bg-[#1a3028]/90">
          Log in
        </Link>
      </div>
    )
  }

  const isBlank = activeConversationId === null && messages.length === 0

  return (
    <div className="flex h-dvh bg-gray-50 overflow-hidden">
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-50 transition-transform duration-200
          md:relative md:inset-auto md:z-auto md:translate-x-0 md:flex-shrink-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <ClientAISidebar
          sidebarOpen={sidebarOpen}
          conversations={conversations}
          convsLoading={convsLoading}
          activeConversationId={activeConversationId}
          onNewChat={() => { startNewChat(); closeSidebarOnMobile() }}
          onSelectConversation={loadConversation}
          onDeleteConversation={deleteConversation}
          companyName={clientUser.companyName}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
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
                  <div className="max-w-[85%] sm:max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm bg-[#1a3028] text-white leading-relaxed">
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
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your hold requests or truck availability…"
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
          <p className="max-w-2xl mx-auto text-xs text-gray-400 mt-1.5 hidden sm:block">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  )
}
