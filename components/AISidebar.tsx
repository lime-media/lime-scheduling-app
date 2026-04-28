'use client'

import Link from 'next/link'
import { signOut } from 'next-auth/react'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConvSummary = {
  id: string
  title: string
  updated_at: string
  message_count: number
}

type Props = {
  sidebarOpen: boolean
  conversations: ConvSummary[]
  convsLoading: boolean
  activeConversationId: string | null
  onNewChat: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string, e: React.MouseEvent) => void
  session: { user?: { name?: string | null; role?: string } } | null | undefined
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const date     = new Date(dateStr)
  const now      = new Date()
  const diffMs   = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1)  return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`

  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24)  return `${diffHrs}h ago`

  const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const dateDay   = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (dateDay.getTime() === yesterday.getTime()) return 'Yesterday'

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AISidebar({
  sidebarOpen,
  conversations,
  convsLoading,
  activeConversationId,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  session,
}: Props) {
  return (
    <aside
      className={`flex flex-col bg-green-900 text-white transition-all duration-200 flex-shrink-0 ${
        sidebarOpen ? 'w-64' : 'w-0 overflow-hidden'
      }`}
    >
      {/* Branding */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-green-800">
        <Link href="/" className="flex items-center">
          <img src="/logo.png" alt="Lime Media" className="h-8 w-auto" />
        </Link>
      </div>

      {/* New Chat */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-green-700 hover:bg-green-600 text-sm font-medium transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Chat
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-3 py-1 space-y-0.5">
        {convsLoading ? (
          <div className="flex justify-center py-6">
            <div className="w-4 h-4 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <p className="text-green-400 text-xs px-2 py-3 text-center leading-relaxed">
            Your conversations will appear here
          </p>
        ) : (
          conversations.map((conv) => {
            const isActive = conv.id === activeConversationId
            return (
              <div
                key={conv.id}
                onClick={() => onSelectConversation(conv.id)}
                className={`group relative flex items-center cursor-pointer rounded-lg pl-3 pr-8 py-2 text-sm transition-colors border-l-2 ${
                  isActive
                    ? 'border-green-400 bg-green-700 text-white'
                    : 'border-transparent text-green-200 hover:bg-green-800 hover:text-white'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{truncate(conv.title, 35)}</div>
                  <div className="text-xs text-green-400 mt-0.5">{relativeTime(conv.updated_at)}</div>
                </div>
                <button
                  onClick={(e) => onDeleteConversation(conv.id, e)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition-opacity p-0.5 rounded"
                  title="Delete conversation"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            )
          })
        )}
      </div>

      {/* Bottom nav */}
      <div className="border-t border-green-800 px-3 py-3 space-y-1">
        <Link
          href="/"
          className="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-green-300 hover:text-white hover:bg-green-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Schedule
        </Link>
        <Link
          href="/holds"
          className="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-green-300 hover:text-white hover:bg-green-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          Holds
        </Link>

        {/* User info + sign out */}
        {session && (
          <div className="pt-2 mt-1 border-t border-green-800">
            <div className="px-3 py-1 text-xs text-green-400 truncate">
              {session.user?.name}
              {session.user?.role && (
                <span className="ml-1 text-green-500">· {session.user.role}</span>
              )}
            </div>
            <button
              onClick={() => signOut({ callbackUrl: '/login' })}
              className="w-full text-left px-3 py-1.5 rounded text-sm text-green-300 hover:text-white hover:bg-green-800 transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
