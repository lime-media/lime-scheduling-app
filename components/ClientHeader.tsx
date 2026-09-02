'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { hasAiAssistantAccess, hasHoldRequestsAccess, type ClientUser } from '@/lib/useClientAuth'
import { PasswordInput } from '@/components/PasswordInput'

const BASE_NAV_LINKS = [
  { href: '/client',     label: 'Schedule' },
  { href: '/client/map', label: 'Map' },
]

export function ClientHeader({ clientUser, authChecked }: { clientUser: ClientUser | null; authChecked: boolean }) {
  const router   = useRouter()
  const pathname = usePathname()

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [userMenuOpen,   setUserMenuOpen]   = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const [showPwModal, setShowPwModal] = useState(false)
  const [currentPw,   setCurrentPw]   = useState('')
  const [newPw,       setNewPw]       = useState('')
  const [confirmPw,   setConfirmPw]   = useState('')
  const [pwLoading,   setPwLoading]   = useState(false)
  const [pwMsg,       setPwMsg]       = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const navLinks = clientUser
    ? [
        ...BASE_NAV_LINKS,
        ...(hasHoldRequestsAccess(clientUser) ? [{ href: '/client/hold-requests', label: 'Reservations' }] : []),
        ...(hasAiAssistantAccess(clientUser) ? [{ href: '/client/ai', label: 'Assistant' }] : []),
      ]
    : BASE_NAV_LINKS

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false)
    }
    if (userMenuOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [userMenuOpen])

  useEffect(() => { setMobileMenuOpen(false) }, [pathname])

  const handleLogout = async () => {
    await fetch('/api/client/auth/logout', { method: 'POST' })
    router.replace('/client/login')
  }

  function openPwModal() {
    setUserMenuOpen(false)
    setMobileMenuOpen(false)
    setCurrentPw(''); setNewPw(''); setConfirmPw('')
    setPwMsg(null)
    setShowPwModal(true)
  }

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPw !== confirmPw) { setPwMsg({ type: 'err', text: 'New passwords do not match' }); return }
    setPwLoading(true)
    setPwMsg(null)
    try {
      const res = await fetch('/api/client/auth/change-password', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      })
      const data = await res.json()
      if (!res.ok) { setPwMsg({ type: 'err', text: data.error || 'Failed' }); return }
      setPwMsg({ type: 'ok', text: 'Password updated successfully.' })
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
    } catch {
      setPwMsg({ type: 'err', text: 'Failed to change password.' })
    } finally {
      setPwLoading(false)
    }
  }

  const linkClass = (href: string) =>
    `px-3 py-1.5 rounded-md text-[13px] font-medium tracking-wide transition-all duration-150 ${
      pathname === href
        ? 'bg-white/20 text-white shadow-sm'
        : 'text-white/80 hover:text-white hover:bg-white/10'
    }`

  return (
    <>
      <header className="bg-gradient-to-r from-[#2d6b22] to-[#3d8b2e] shadow-md flex-shrink-0 relative z-40">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            {/* Logo + title */}
            <Link href="/client" className="flex items-center gap-3 min-w-0 flex-shrink-0">
              <Image src="/logo.png" alt="Lime Media" width={259} height={194} className="h-8 w-auto flex-shrink-0" />
              <span className="hidden md:inline text-white/90 font-semibold text-sm tracking-wide truncate">
                Lime Media LED Scheduling
              </span>
            </Link>

            {/* Desktop nav + account */}
            <div className="hidden sm:flex items-center gap-0.5 flex-shrink-0">
              {navLinks.map((link) => (
                <Link key={link.href} href={link.href} className={linkClass(link.href)}>
                  {link.label}
                </Link>
              ))}

              {authChecked && (
                clientUser ? (
                  <div ref={userMenuRef} className="relative ml-1">
                    <button
                      onClick={() => setUserMenuOpen((o) => !o)}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] font-medium text-white/80 hover:text-white hover:bg-white/10 transition-all"
                    >
                      <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-white text-xs font-bold">
                        {clientUser.companyName?.charAt(0)?.toUpperCase()}
                      </div>
                      <span className="max-w-[9rem] truncate">{clientUser.companyName}</span>
                      <svg className={`w-3 h-3 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {userMenuOpen && (
                      <div className="absolute right-0 top-full mt-1.5 w-48 bg-white rounded-lg shadow-xl border border-gray-200/80 py-1 z-50">
                        <div className="px-4 py-2 border-b border-gray-100">
                          <p className="text-xs font-medium text-gray-700">{clientUser.companyName}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{clientUser.username}</p>
                        </div>
                        <button onClick={openPwModal} className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                          Change Password
                        </button>
                        <button onClick={handleLogout} className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                          Log Out
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <Link href="/client/login" className="ml-2 px-3 py-1.5 rounded-md text-[13px] font-medium bg-white/20 text-white hover:bg-white/30 transition-colors">
                    Log In
                  </Link>
                )
              )}
            </div>

            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileMenuOpen((o) => !o)}
              className="sm:hidden p-2 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors"
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

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="sm:hidden border-t border-white/10 bg-[#2d6b22]/95 backdrop-blur-sm px-4 py-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`block px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                  pathname === link.href
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:text-white hover:bg-white/10'
                }`}
              >
                {link.label}
              </Link>
            ))}

            {authChecked && (
              clientUser ? (
                <div className="pt-2 mt-2 border-t border-white/10">
                  <div className="px-3 py-2 text-xs text-white/50 truncate">{clientUser.companyName}</div>
                  <button onClick={openPwModal}
                    className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/10 transition-colors">
                    Change Password
                  </button>
                  <button onClick={handleLogout}
                    className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-red-300 hover:text-red-200 hover:bg-white/10 transition-colors">
                    Log Out
                  </button>
                </div>
              ) : (
                <Link href="/client/login" onClick={() => setMobileMenuOpen(false)}
                  className="block text-center px-3 py-3 rounded-lg text-sm font-semibold bg-white/20 text-white mt-2">
                  Log In
                </Link>
              )
            )}
          </div>
        )}
      </header>

      {/* Change Password modal */}
      {showPwModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">Change Password</h2>
              <p className="text-xs text-gray-500 mt-0.5">Enter your current password and choose a new one.</p>
            </div>
            <form onSubmit={handlePasswordChange} className="px-6 py-5 space-y-4">
              {[
                { label: 'Current Password', value: currentPw, set: setCurrentPw, auto: 'current-password' },
                { label: 'New Password',     value: newPw,     set: setNewPw,     auto: 'new-password' },
                { label: 'Confirm New',      value: confirmPw, set: setConfirmPw, auto: 'new-password' },
              ].map(({ label, value, set, auto }) => (
                <div key={label}>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
                  <PasswordInput
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    autoComplete={auto}
                    required
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>
              ))}
              {pwMsg && (
                <div className={`rounded-lg px-3 py-2 text-sm ${pwMsg.type === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                  {pwMsg.text}
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowPwModal(false)}
                  className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
                  Close
                </button>
                <button type="submit" disabled={pwLoading}
                  className="flex-1 bg-green-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50">
                  {pwLoading ? 'Saving...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
