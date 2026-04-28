'use client'

import { useEffect, useRef, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import toast from 'react-hot-toast'

export function Navbar() {
  const { data: session } = useSession()
  const pathname = usePathname()

  const [conflictCount,     setConflictCount]     = useState(0)
  const [hasRecentConflict, setHasRecentConflict] = useState(false)

  // User dropdown
  const [userMenuOpen,  setUserMenuOpen]  = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // Change password modal
  const [changePwOpen,    setChangePwOpen]    = useState(false)
  const [changePwForm,    setChangePwForm]    = useState({ current: '', next: '', confirm: '' })
  const [changePwError,   setChangePwError]   = useState('')
  const [changePwLoading, setChangePwLoading] = useState(false)
  const [showCurrent,     setShowCurrent]     = useState(false)
  const [showNext,        setShowNext]        = useState(false)

  useEffect(() => {
    if (!session) return
    fetch('/api/conflicts')
      .then((r) => (r.ok ? r.json() : { conflicts: [] }))
      .then((data) => {
        const list = (data.conflicts ?? []) as { detected_at: string }[]
        setConflictCount(list.length)
        const oneHourAgo = Date.now() - 60 * 60 * 1000
        setHasRecentConflict(list.some((c) => new Date(c.detected_at).getTime() > oneHourAgo))
      })
      .catch(() => {})
  }, [session])

  // Close user dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    if (userMenuOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [userMenuOpen])

  function openChangePw() {
    setUserMenuOpen(false)
    setChangePwForm({ current: '', next: '', confirm: '' })
    setChangePwError('')
    setShowCurrent(false)
    setShowNext(false)
    setChangePwOpen(true)
  }

  async function handleChangePw(e: React.FormEvent) {
    e.preventDefault()
    setChangePwError('')

    if (changePwForm.next !== changePwForm.confirm) {
      setChangePwError('New passwords do not match')
      return
    }
    if (changePwForm.next.length < 8) {
      setChangePwError('New password must be at least 8 characters')
      return
    }

    setChangePwLoading(true)
    try {
      const res = await fetch('/api/users/me/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: changePwForm.current,
          newPassword:     changePwForm.next,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setChangePwError(data.error || 'Failed to change password')
      } else {
        setChangePwOpen(false)
        toast.success('Password changed successfully')
      }
    } finally {
      setChangePwLoading(false)
    }
  }

  const isOps = session?.user?.role === 'OPERATIONS'

  return (
    <>
      <nav className="bg-[#1a3028] text-white px-6 py-3 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center">
            <img src="/logo.png" alt="Lime Media" className="h-10 w-auto" />
          </Link>
          <div className="hidden sm:flex items-center gap-4 text-sm font-medium">
            <Link
              href="/"
              className={`px-3 py-1.5 rounded transition-colors ${
                pathname === '/' ? 'bg-[#0f1f18] text-white' : 'text-green-100 hover:text-white hover:bg-[#0f1f18]'
              }`}
            >
              Schedule
            </Link>
            <Link
              href="/map"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors ${
                pathname === '/map' ? 'bg-[#0f1f18] text-white' : 'text-green-100 hover:text-white hover:bg-[#0f1f18]'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Map
            </Link>
            <Link
              href="/ai"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors ${
                pathname === '/ai' ? 'bg-[#0f1f18] text-white' : 'text-green-100 hover:text-white hover:bg-[#0f1f18]'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              AI Assistant
            </Link>
            <Link
              href="/holds"
              className={`px-3 py-1.5 rounded transition-colors ${
                pathname === '/holds' ? 'bg-[#0f1f18] text-white' : 'text-green-100 hover:text-white hover:bg-[#0f1f18]'
              }`}
            >
              Holds
            </Link>
            <Link
              href="/conflicts"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors ${
                pathname === '/conflicts' ? 'bg-[#0f1f18] text-white' : 'text-green-100 hover:text-white hover:bg-[#0f1f18]'
              }`}
            >
              Conflicts
              {conflictCount > 0 && (
                <span
                  className={`bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none ${
                    hasRecentConflict ? 'animate-pulse' : ''
                  }`}
                >
                  {conflictCount}
                </span>
              )}
            </Link>
            {isOps && (
              <Link
                href="/users"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors ${
                  pathname === '/users' ? 'bg-[#0f1f18] text-white' : 'text-green-100 hover:text-white hover:bg-[#0f1f18]'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
                Users
              </Link>
            )}
          </div>
        </div>

        {/* Right side: user dropdown */}
        <div className="flex items-center gap-4">
          {session && (
            <div ref={userMenuRef} className="relative">
              <button
                onClick={() => setUserMenuOpen((o) => !o)}
                className="flex items-center gap-1.5 text-sm text-green-200 hover:text-white transition-colors hidden sm:flex"
              >
                <span>
                  {session.user?.name} &middot;{' '}
                  <span className="text-green-300 font-medium">{session.user?.role}</span>
                </span>
                <svg className="w-3.5 h-3.5 text-green-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 text-gray-800">
                  <button
                    onClick={openChangePw}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                  >
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                    </svg>
                    Change Password
                  </button>
                  <hr className="my-1 border-gray-100" />
                  <button
                    onClick={() => signOut({ callbackUrl: '/login' })}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 text-red-600"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </nav>

      {/* ── Change Password Modal ──────────────────────────────────────────────── */}
      {changePwOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Change Password</h2>
            </div>
            <form onSubmit={handleChangePw} className="px-6 py-4 space-y-4">
              {/* Current password */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Current Password</label>
                <div className="relative">
                  <input
                    type={showCurrent ? 'text' : 'password'}
                    required
                    value={changePwForm.current}
                    onChange={(e) => setChangePwForm({ ...changePwForm, current: e.target.value })}
                    className="w-full border border-gray-300 rounded px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button type="button" onClick={() => setShowCurrent((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {showCurrent
                        ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        : <><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></>
                      }
                    </svg>
                  </button>
                </div>
              </div>
              {/* New password */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                <div className="relative">
                  <input
                    type={showNext ? 'text' : 'password'}
                    required
                    value={changePwForm.next}
                    onChange={(e) => setChangePwForm({ ...changePwForm, next: e.target.value })}
                    className="w-full border border-gray-300 rounded px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button type="button" onClick={() => setShowNext((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {showNext
                        ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        : <><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></>
                      }
                    </svg>
                  </button>
                </div>
              </div>
              {/* Confirm */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm New Password</label>
                <input
                  type="password"
                  required
                  value={changePwForm.confirm}
                  onChange={(e) => setChangePwForm({ ...changePwForm, confirm: e.target.value })}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>

              {changePwError && (
                <p className="text-sm text-red-600">{changePwError}</p>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setChangePwOpen(false)}
                  className="px-4 py-2 text-sm border border-gray-300 rounded text-gray-600 hover:text-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={changePwLoading}
                  className="px-4 py-2 text-sm bg-green-700 hover:bg-green-600 text-white rounded transition-colors disabled:opacity-50"
                >
                  {changePwLoading ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
