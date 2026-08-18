'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { hasAiAssistantAccess, type ClientUser } from '@/lib/useClientAuth'

const BASE_NAV_LINKS = [
  { href: '/client',     label: 'Schedule' },
  { href: '/client/map', label: 'Map' },
]

/**
 * Shared header for all /client/* pages.
 *
 * Logo + title are grouped together on the left (not independently centered), and nav +
 * account actions live on the right, collapsing into a compact dropdown/hamburger — the same
 * pattern the internal Navbar already uses. This is deliberate: with the title centered via
 * leftover flex space, every new nav item (Map, My Requests, company name, Password, Log out…)
 * shrank that leftover space unevenly and dragged the title left. Grouping it with the logo
 * means it can never drift again, no matter how many links get added later.
 */
export function ClientHeader({ clientUser, authChecked }: { clientUser: ClientUser | null; authChecked: boolean }) {
  const router   = useRouter()
  const pathname = usePathname()

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [userMenuOpen,   setUserMenuOpen]   = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // Change password modal
  const [showPwModal, setShowPwModal] = useState(false)
  const [currentPw,   setCurrentPw]   = useState('')
  const [newPw,       setNewPw]       = useState('')
  const [confirmPw,   setConfirmPw]   = useState('')
  const [pwLoading,   setPwLoading]   = useState(false)
  const [pwMsg,       setPwMsg]       = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const navLinks = clientUser
    ? [
        ...BASE_NAV_LINKS,
        { href: '/client/hold-requests', label: 'My Requests' },
        ...(hasAiAssistantAccess(clientUser) ? [{ href: '/client/ai', label: 'Assistant' }] : []),
      ]
    : BASE_NAV_LINKS

  // Close desktop dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false)
    }
    if (userMenuOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [userMenuOpen])

  // Close mobile menu on route change
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

  return (
    <>
      <header className="bg-[#94ce3a] shadow-lg flex-shrink-0">
        <div className="px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          {/* Logo + title — grouped so nav growth on the right can never push this around */}
          <Link href="/client" className="flex items-center gap-3 min-w-0 flex-shrink-0">
            <Image src="/logo.png" alt="Lime Media" width={259} height={194} className="h-9 w-auto flex-shrink-0" />
            <span className="hidden md:inline text-[#1a3028] font-bold text-lg truncate">
              Lime Media Scheduling Availability
            </span>
          </Link>

          {/* Desktop nav + account menu */}
          <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  pathname === link.href ? 'bg-[#1a3028] text-white' : 'text-[#1a3028] hover:bg-[#1a3028]/20'
                }`}
              >
                {link.label}
              </Link>
            ))}

            {authChecked && (
              clientUser ? (
                <div ref={userMenuRef} className="relative ml-1">
                  <button
                    onClick={() => setUserMenuOpen((o) => !o)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium text-[#1a3028] hover:bg-[#1a3028]/20 transition-colors"
                  >
                    <span className="max-w-[9rem] truncate">{clientUser.companyName}</span>
                    <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {userMenuOpen && (
                    <div className="absolute right-0 top-full mt-2 w-44 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 text-gray-800">
                      <button onClick={openPwModal} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50">
                        Change Password
                      </button>
                      <hr className="my-1 border-gray-100" />
                      <button onClick={handleLogout} className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 text-red-600">
                        Log out
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <Link href="/client/login" className="ml-2 px-3 py-1.5 rounded text-sm font-medium bg-[#1a3028] text-white hover:bg-[#1a3028]/90">
                  Log in
                </Link>
              )
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen((o) => !o)}
            className="sm:hidden p-2 rounded text-[#1a3028] hover:bg-[#1a3028]/20 transition-colors"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="sm:hidden border-t border-[#1a3028]/20 px-4 py-3 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`block px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                  pathname === link.href ? 'bg-[#1a3028] text-white' : 'text-[#1a3028] hover:bg-[#1a3028]/20'
                }`}
              >
                {link.label}
              </Link>
            ))}

            {authChecked && (
              clientUser ? (
                <div className="pt-3 mt-2 border-t border-[#1a3028]/20">
                  <div className="px-3 py-1 text-xs text-[#1a3028] mb-1 truncate">{clientUser.companyName}</div>
                  <button onClick={openPwModal} className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-[#1a3028] hover:bg-[#1a3028]/20 transition-colors">
                    Change Password
                  </button>
                  <button onClick={handleLogout} className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-red-700 hover:bg-[#1a3028]/10 transition-colors">
                    Log out
                  </button>
                </div>
              ) : (
                <Link
                  href="/client/login"
                  onClick={() => setMobileMenuOpen(false)}
                  className="block text-center px-3 py-3 rounded-lg text-sm font-semibold bg-[#1a3028] text-white"
                >
                  Log in
                </Link>
              )
            )}
          </div>
        )}
      </header>

      {/* Change Password modal */}
      {showPwModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-bold text-gray-900 mb-4">Change Password</h2>
            <form onSubmit={handlePasswordChange} className="space-y-3">
              {[
                { label: 'Current password', value: currentPw, set: setCurrentPw, auto: 'current-password' },
                { label: 'New password',     value: newPw,     set: setNewPw,     auto: 'new-password' },
                { label: 'Confirm new',      value: confirmPw, set: setConfirmPw, auto: 'new-password' },
              ].map(({ label, value, set, auto }) => (
                <div key={label}>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                  <input
                    type="password"
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    autoComplete={auto}
                    required
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
              ))}
              {pwMsg && <p className={`text-xs ${pwMsg.type === 'ok' ? 'text-green-600' : 'text-red-600'}`}>{pwMsg.text}</p>}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowPwModal(false)} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded text-sm hover:bg-gray-50">
                  Close
                </button>
                <button type="submit" disabled={pwLoading} className="flex-1 bg-[#1a3028] text-white py-2 rounded text-sm font-medium hover:bg-[#1a3028]/90 disabled:opacity-50">
                  {pwLoading ? 'Saving…' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
