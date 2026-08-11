'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [step, setStep] = useState<'credentials' | 'otp'>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/request-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to send verification code')
        return
      }
      setInfo(`We sent a 6-digit code to ${email}.`)
      setStep('otp')
    } catch {
      setError('Failed to send verification code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = await signIn('credentials', {
      email,
      password,
      otp,
      redirect: false,
    })

    setLoading(false)

    if (result?.error) {
      // authorize() throws user-facing messages (expired / wrong code /
      // attempts left) — next-auth passes them through here verbatim.
      setError(result.error)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  const handleResend = async () => {
    setError('')
    setInfo('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/request-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Failed to resend code')
        return
      }
      setInfo(`We sent a new code to ${email}.`)
    } catch {
      setError('Failed to resend code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-900 to-green-700 px-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-3">
            <img src="/logo.png" alt="Lime Media" className="h-16 w-auto" />
          </div>
          <h1 className="text-3xl font-bold text-white">Lime Media</h1>
          <p className="text-green-200 mt-1 text-sm">Scheduling Assistant</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl px-8 py-8">
          <h2 className="text-xl font-bold text-gray-900 mb-6">
            {step === 'credentials' ? 'Sign in to your account' : 'Enter verification code'}
          </h2>

          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
              {error}
            </div>
          )}
          {info && !error && (
            <div className="mb-4 bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-3 rounded-lg">
              {info}
            </div>
          )}

          {step === 'credentials' ? (
            <form onSubmit={handleCredentialsSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent transition"
                  placeholder="you@limemedia.com"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent transition"
                  placeholder="••••••••"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-green-700 hover:bg-green-800 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors disabled:opacity-60 mt-2"
              >
                {loading ? 'Sending code...' : 'Continue'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleOtpSubmit} className="space-y-4">
              <div>
                <label htmlFor="otp" className="block text-sm font-medium text-gray-700 mb-1">
                  6-digit code
                </label>
                <input
                  id="otp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  autoFocus
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm text-center text-lg tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent transition"
                  placeholder="······"
                />
              </div>

              <button
                type="submit"
                disabled={loading || otp.length !== 6}
                className="w-full bg-green-700 hover:bg-green-800 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors disabled:opacity-60 mt-2"
              >
                {loading ? 'Verifying...' : 'Verify and sign in'}
              </button>

              <div className="flex items-center justify-between text-xs pt-1">
                <button
                  type="button"
                  onClick={() => { setStep('credentials'); setOtp(''); setError(''); setInfo('') }}
                  className="text-gray-500 hover:text-gray-700"
                >
                  ← Use a different account
                </button>
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={loading}
                  className="text-green-700 hover:text-green-800 font-medium disabled:opacity-60"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="text-center text-green-300 text-xs mt-6">
          Contact your administrator to create an account
        </p>
      </div>
    </div>
  )
}
