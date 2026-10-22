'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PasswordInput } from '@/components/PasswordInput'

/**
 * Client-portal login, in two steps like the internal one: the password gets
 * a code emailed, the code signs you in. The password is re-checked on the
 * second call, so reaching step 2 is not on its own a way in.
 */
export default function ClientLoginPage() {
  const router = useRouter()
  const [step,     setStep]     = useState<'credentials' | 'code'>('credentials')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code,     setCode]     = useState('')
  const [sentTo,   setSentTo]   = useState('')
  const [error,    setError]    = useState('')
  const [notice,   setNotice]   = useState('')
  const [loading,  setLoading]  = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)

  // Step 1: password checked, code emailed.
  const handleCredentials = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setNotice(''); setLoading(true)
    try {
      const res = await fetch('/api/client/auth/request-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Invalid credentials')
        return
      }
      setSentTo(data.sentTo || '')
      setStep('code')
      setTimeout(() => codeRef.current?.focus(), 50)
    } catch {
      setError('Could not send a code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Step 2: code verified, session issued.
  const handleCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(''); setNotice(''); setLoading(true)
    try {
      const res = await fetch('/api/client/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password, otp: code }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'That code did not work.')
        return
      }
      router.replace('/client')
    } catch {
      setError('Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    setError(''); setNotice(''); setLoading(true)
    try {
      const res = await fetch('/api/client/auth/request-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setError(data.error || 'Could not send another code.')
      else { setCode(''); setNotice('A new code is on its way.') }
    } catch {
      setError('Could not send another code.')
    } finally {
      setLoading(false)
    }
  }

  const startOver = () => {
    setStep('credentials'); setCode(''); setSentTo(''); setError(''); setNotice('')
  }

  const handleGuest = async () => {
    setLoading(true)
    await fetch('/api/client/auth/guest', { method: 'POST' })
    router.replace('/client')
  }

  const inputClass = 'w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent transition'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#1a3a1a] via-[#2d6b22] to-[#3d8b2e] px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <img src="/logo.png" alt="Lime Media" className="h-14 w-auto" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">LED Scheduling</h1>
          <p className="text-white/50 mt-1 text-sm">View availability and manage reservations</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl px-8 py-8 border border-white/10">
          {step === 'credentials' ? (
            <>
              <h2 className="text-xl font-bold text-gray-900 mb-1">Client Login</h2>
              <p className="text-sm text-gray-500 mb-6">
                Sign in with your account credentials. We&apos;ll email you a code to finish.
              </p>

              <form onSubmit={handleCredentials} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Username</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    required
                    className={inputClass}
                    placeholder="Enter your username"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                  <PasswordInput
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className={inputClass}
                    placeholder="Enter your password"
                  />
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-green-700 hover:bg-green-800 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors disabled:opacity-60 mt-1"
                >
                  {loading ? 'Sending code...' : 'Continue'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold text-gray-900 mb-1">Enter your code</h2>
              <p className="text-sm text-gray-500 mb-6">
                We emailed a 6-digit code{sentTo ? <> to <span className="font-medium text-gray-700">{sentTo}</span></> : ''}.
                It expires in 10 minutes.
              </p>

              <form onSubmit={handleCode} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Code</label>
                  <input
                    ref={codeRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    required
                    className={`${inputClass} tracking-[0.4em] text-center text-lg font-semibold`}
                    placeholder="······"
                  />
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2.5 rounded-lg">
                    {error}
                  </div>
                )}
                {notice && (
                  <div className="bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-2.5 rounded-lg">
                    {notice}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || code.length < 6}
                  className="w-full bg-green-700 hover:bg-green-800 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors disabled:opacity-60 mt-1"
                >
                  {loading ? 'Verifying...' : 'Sign In'}
                </button>
              </form>

              <div className="mt-4 flex items-center justify-between text-xs">
                <button onClick={startOver} disabled={loading} className="text-gray-500 hover:text-gray-700 disabled:opacity-50">
                  Use a different account
                </button>
                <button onClick={handleResend} disabled={loading} className="text-green-700 hover:text-green-900 font-medium disabled:opacity-50">
                  Send a new code
                </button>
              </div>
            </>
          )}

          <div className="mt-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400">or</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          <button
            onClick={handleGuest}
            disabled={loading}
            className="mt-5 w-full border border-gray-200 text-gray-600 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Continue as Guest
          </button>
        </div>

        <p className="text-center text-white/30 text-xs mt-6">
          Contact your account representative for access
        </p>
      </div>
    </div>
  )
}
