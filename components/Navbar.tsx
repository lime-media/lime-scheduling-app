'use client'

import { useEffect, useRef, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import toast from 'react-hot-toast'
import { PasswordInput } from '@/components/PasswordInput'

export function Navbar() {
  const { data: session } = useSession()
  const pathname = usePathname()

  const [conflictCount,     setConflictCount]     = useState(0)
  const [hasRecentConflict, setHasRecentConflict] = useState(false)

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const [changePwOpen,    setChangePwOpen]    = useState(false)
  const [changePwForm,    setChangePwForm]    = useState({ current: '', next: '', confirm: '' })
  const [changePwError,   setChangePwError]   = useState('')
  const [changePwLoading, setChangePwLoading] = useState(false)

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

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false)
    }
    if (userMenuOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [userMenuOpen])

  useEffect(() => { setMobileMenuOpen(false) }, [pathname])

  function openChangePw() {
    setUserMenuOpen(false)
    setMobileMenuOpen(false)
    setChangePwForm({ current: '', next: '', confirm: '' })
    setChangePwError('')
    setChangePwOpen(true)
  }

  async function handleChangePw(e: React.FormEvent) {
    e.preventDefault()
    setChangePwError('')
    if (changePwForm.next !== changePwForm.confirm) { setChangePwError('New passwords do not match'); return }
    if (changePwForm.next.length < 8) { setChangePwError('New password must be at least 8 characters'); return }
    setChangePwLoading(true)
    try {
      const res = await fetch('/api/users/me/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: changePwForm.current, newPassword: changePwForm.next }),
      })
      const data = await res.json()
      if (!res.ok) setChangePwError(data.error || 'Failed to change password')
      else { setChangePwOpen(false); toast.success('Password changed successfully') }
    } finally {
      setChangePwLoading(false)
    }
  }

  const navLinks = [
    { href: '/',                       label: 'Schedule' },
    { href: '/map',                    label: 'Map' },
    { href: '/ai',                     label: 'AI Assistant' },
    { href: '/hold-requests',          label: 'Reservations' },
    { href: '/conflicts',              label: 'Conflicts', badge: conflictCount > 0 ? conflictCount : null, pulse: hasRecentConflict },
    { href: '/quote',                  label: 'LED Quote' },
    { href: '/saturation-calculator',  label: 'Saturation' },
    { href: '/rate-cards', label: 'Rate Cards' },
    { href: '/users', label: 'Users' },
  ]

  const linkClass = (href: string) =>
    `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium tracking-wide transition-all duration-150 ${
      pathname === href
        ? 'bg-white/20 text-white shadow-sm backdrop-blur-sm'
        : 'text-white/80 hover:text-white hover:bg-white/10'
    }`

  return (
    <>
      <nav className="bg-gradient-to-r from-[#2d6b22] to-[#3d8b2e] shadow-md relative z-40">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            {/* Logo + Nav */}
            <div className="flex items-center gap-6">
              <Link href="/" className="flex items-center flex-shrink-0">
                <img src="/logo.png" alt="Lime Media" className="h-8 w-auto" />
              </Link>

              <div className="hidden lg:flex items-center gap-0.5">
                {navLinks.map((link) => (
                  <Link key={link.href} href={link.href} className={linkClass(link.href)}>
                    {link.label}
                    {link.badge != null && (
                      <span className={`bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ml-0.5 ${link.pulse ? 'animate-pulse' : ''}`}>
                        {link.badge}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            </div>

            {/* Right side */}
            <div className="flex items-center gap-3">
              {session && (
                <div ref={userMenuRef} className="relative hidden lg:block">
                  <button
                    onClick={() => setUserMenuOpen((o) => !o)}
                    className="flex items-center gap-2 text-[13px] text-white/80 hover:text-white transition-colors rounded-md px-2.5 py-1.5 hover:bg-white/10"
                  >
                    <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-white text-xs font-bold">
                      {session.user?.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <span className="font-medium">{session.user?.name}</span>
                    <svg className={`w-3 h-3 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {userMenuOpen && (
                    <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-lg shadow-xl border border-gray-200/80 py-1 z-50">
                      <div className="px-4 py-2 border-b border-gray-100">
                        <p className="text-xs text-gray-500">{session.user?.email}</p>
                        <p className="text-xs font-medium text-gray-700 mt-0.5">{session.user?.role === 'OPERATIONS' ? 'Operations' : 'Sales'}</p>
                      </div>
                      <button onClick={openChangePw} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 transition-colors">
                        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                        </svg>
                        Change Password
                      </button>
                      <button onClick={() => signOut({ callbackUrl: '/login' })} className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5 transition-colors">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                        </svg>
                        Sign Out
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileMenuOpen((o) => !o)}
                className="lg:hidden p-2 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-white/10 bg-[#2d6b22]/95 backdrop-blur-sm px-4 py-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center justify-between px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                  pathname === link.href
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:text-white hover:bg-white/10'
                }`}
              >
                {link.label}
                {link.badge != null && (
                  <span className={`bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full ${link.pulse ? 'animate-pulse' : ''}`}>
                    {link.badge}
                  </span>
                )}
              </Link>
            ))}

            {session && (
              <div className="pt-2 mt-2 border-t border-white/10">
                <div className="px-3 py-2 text-xs text-white/50">
                  {session.user?.name} &middot; {session.user?.role === 'OPERATIONS' ? 'Operations' : 'Sales'}
                </div>
                <button onClick={openChangePw}
                  className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/10 transition-colors">
                  Change Password
                </button>
                <button onClick={() => signOut({ callbackUrl: '/login' })}
                  className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-red-300 hover:text-red-200 hover:bg-white/10 transition-colors">
                  Sign Out
                </button>
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Change Password Modal */}
      {changePwOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">Change Password</h2>
              <p className="text-xs text-gray-500 mt-0.5">Enter your current password and choose a new one.</p>
            </div>
            <form onSubmit={handleChangePw} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Current Password</label>
                <PasswordInput
                  required
                  value={changePwForm.current}
                  onChange={(e) => setChangePwForm({ ...changePwForm, current: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
                <PasswordInput
                  required
                  value={changePwForm.next}
                  onChange={(e) => setChangePwForm({ ...changePwForm, next: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm New Password</label>
                <PasswordInput
                  required
                  value={changePwForm.confirm}
                  onChange={(e) => setChangePwForm({ ...changePwForm, confirm: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
              {changePwError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <p className="text-sm text-red-700">{changePwError}</p>
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setChangePwOpen(false)}
                  className="px-4 py-2.5 text-sm font-medium border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={changePwLoading}
                  className="px-4 py-2.5 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50">
                  {changePwLoading ? 'Saving...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
