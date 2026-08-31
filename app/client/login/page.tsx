'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PasswordInput } from '@/components/PasswordInput'

export default function ClientLoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/client/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Invalid credentials')
        return
      }
      router.replace('/client')
    } catch {
      setError('Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleGuest = async () => {
    setLoading(true)
    await fetch('/api/client/auth/guest', { method: 'POST' })
    router.replace('/client')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <div className="bg-[#94ce3a] shadow-lg px-6 py-3 flex items-center justify-center">
        <img src="/logo.png" alt="Lime Media" className="h-9 w-auto" />
        <span className="ml-4 text-[#1a3028] font-bold text-lg">Lime Media Scheduling</span>
      </div>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-xl shadow-md p-8">
          <h1 className="text-xl font-bold text-gray-900 mb-1">Client Portal</h1>
          <p className="text-sm text-gray-500 mb-6">Sign in to view availability and submit hold requests.</p>

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#1a3028] text-white py-2 rounded text-sm font-medium hover:bg-[#1a3028]/90 disabled:opacity-50"
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400">or</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          <button
            onClick={handleGuest}
            disabled={loading}
            className="mt-4 w-full border border-gray-300 text-gray-600 py-2 rounded text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            Continue as Guest →
          </button>
        </div>
      </div>
    </div>
  )
}
