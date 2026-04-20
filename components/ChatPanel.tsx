'use client'

import { useState, useRef, useEffect } from 'react'

type Message = {
  role: 'user' | 'assistant'
  content: string
  isAction?: boolean
  actionOk?: boolean
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        "Hi! I'm your Lime Media Scheduling Assistant. Ask me about truck availability, holds, conflicts, or anything related to the schedule.",
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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
          history: messages.slice(-10), // last 10 messages for context
        }),
      })
      const data = await res.json()
      if (res.ok) {
        const msgs: Message[] = [
          ...newHistory,
          { role: 'assistant', content: data.reply },
        ]
        // Append a system notice when an action was executed
        if (data.actionResult) {
          msgs.push({
            role: 'assistant',
            content: data.actionResult.message,
            isAction: true,
            actionOk: data.actionResult.success,
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
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                msg.isAction
                  ? msg.actionOk
                    ? 'bg-green-50 text-green-800 border border-green-200 rounded-tl-sm font-medium'
                    : 'bg-red-50 text-red-800 border border-red-200 rounded-tl-sm font-medium'
                  : msg.role === 'user'
                  ? 'bg-green-700 text-white rounded-tr-sm'
                  : 'bg-gray-100 text-gray-800 rounded-tl-sm'
              }`}
            >
              {msg.isAction && (
                <span className="mr-1">{msg.actionOk ? '✓' : '✗'}</span>
              )}
              {msg.content}
            </div>
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
