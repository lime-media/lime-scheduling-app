'use client'


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
  session?: { user?: { name?: string | null; role?: string } } | null | undefined
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
}: Props) {
  return (
    <aside
      className={`flex flex-col bg-white border-r border-gray-200 text-gray-900 h-full transition-all duration-200 flex-shrink-0 w-64 ${
        !sidebarOpen ? 'md:w-0 md:overflow-hidden' : ''
      }`}
    >
      {/* New Chat */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors"
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
            <div className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <p className="text-gray-400 text-xs px-2 py-3 text-center leading-relaxed">
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
                    ? 'border-green-600 bg-green-50 text-green-900'
                    : 'border-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{truncate(conv.title, 35)}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{relativeTime(conv.updated_at)}</div>
                </div>
                <button
                  onClick={(e) => onDeleteConversation(conv.id, e)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-opacity p-0.5 rounded"
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

    </aside>
  )
}
