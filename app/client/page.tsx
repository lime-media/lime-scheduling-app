'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { format, addDays, startOfDay, parseISO } from 'date-fns'
import { ScheduleGrid, type TruckInfo, type ScheduleBlock, type HoldBlock, type HoldRequestBlock } from '@/components/ScheduleGrid'
import { FilterBar } from '@/components/FilterBar'
import { ScheduleSkeleton } from '@/components/LoadingSkeleton'
import { ClientHeader } from '@/components/ClientHeader'

type Filters = {
  state: string
  market: string
  statusFilters: Set<string>
  dateFrom: string
  dateTo: string
}

type ClientUser = {
  id: string
  username: string
  companyName: string
}

type HoldRequestDraft = {
  truckNum: string
  start: string
  end: string
  market: string
}

const today = startOfDay(new Date())
const DEFAULT_RANGE_DAYS = 63 // 9 weeks
const FIREFLY_RANGE_DAYS = 14 // 2 weeks — Firefly is restricted to a shorter lookahead

function isFirefly(companyName: string | undefined | null): boolean {
  return (companyName ?? '').trim().toLowerCase() === 'firefly'
}

const defaultFilters: Filters = {
  state: '',
  market: '',
  statusFilters: new Set(),
  dateFrom: format(today, 'yyyy-MM-dd'),
  dateTo: format(addDays(today, DEFAULT_RANGE_DAYS), 'yyyy-MM-dd'),
}

export default function ClientPage() {
  const router   = useRouter()
  const pathname = usePathname()

  const [clientUser,    setClientUser]    = useState<ClientUser | null>(null)
  const [authChecked,   setAuthChecked]   = useState(false)

  // Staged rollout — the redesigned header/nav and cross-client hold-request visibility are
  // limited to the testclient account in production until validated more broadly. Everyone
  // else keeps the current portal experience unchanged. See app/api/client/chat/route.ts.
  const isTestClient = clientUser?.username === 'testclient'

  const [trucks,        setTrucks]        = useState<TruckInfo[]>([])
  const [schedules,     setSchedules]     = useState<ScheduleBlock[]>([])
  const [holdBlocks,    setHoldBlocks]    = useState<HoldBlock[]>([])
  const [holdRequests,       setHoldRequests]       = useState<HoldRequestBlock[]>([])  // this client's own requests, full detail
  const [otherHoldRequests,  setOtherHoldRequests]  = useState<HoldRequestBlock[]>([])  // other clients' pending requests, redacted — testclient rollout only, see isTestClient below
  const [markets,       setMarkets]       = useState<string[]>([])
  const [states,        setStates]        = useState<string[]>([])
  const [filters,       setFilters]       = useState<Filters>(defaultFilters)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')

  // Hold request draft (from drag)
  const [draft,         setDraft]         = useState<HoldRequestDraft | null>(null)
  const [draftNotes,    setDraftNotes]    = useState('')
  const [draftLoading,  setDraftLoading]  = useState(false)
  const [draftError,    setDraftError]    = useState('')

  // Change password modal
  const [showPwModal,   setShowPwModal]   = useState(false)
  const [currentPw,     setCurrentPw]     = useState('')
  const [newPw,         setNewPw]         = useState('')
  const [confirmPw,     setConfirmPw]     = useState('')
  const [pwLoading,     setPwLoading]     = useState(false)
  const [pwMsg,         setPwMsg]         = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  // Check auth on mount
  useEffect(() => {
    fetch('/api/client/auth/me')
      .then((r) => r.json())
      .then((d) => {
        const user: ClientUser | null = d.user ?? null
        setClientUser(user)
        setAuthChecked(true)
        if (isFirefly(user?.companyName)) {
          setFilters((f) => ({ ...f, dateTo: format(addDays(today, FIREFLY_RANGE_DAYS), 'yyyy-MM-dd') }))
        }
      })
      .catch(() => setAuthChecked(true))
  }, [])

  const fetchHoldRequests = useCallback(async () => {
    if (!clientUser) return
    try {
      const res  = await fetch('/api/client/hold-requests')
      if (!res.ok) return
      const data = await res.json()
      setHoldRequests(data.holdRequests || [])
    } catch { /* non-fatal */ }
  }, [clientUser])

  const fetchSchedule = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/client/schedule')
      if (!res.ok) throw new Error('Failed to fetch schedule')
      const data = await res.json()
      const schedulesData: ScheduleBlock[] = data.schedules || []
      setTrucks(data.trucks       || [])
      setSchedules(schedulesData)
      setHoldBlocks(data.holds    || [])
      setOtherHoldRequests(data.holdRequests || [])
      setMarkets(data.markets?.length ? data.markets : [...new Set(schedulesData.map((s: ScheduleBlock) => s.standard_market_name || s.market).filter(Boolean))].sort())
      setStates([...new Set(schedulesData.map((s) => s.state).filter(Boolean))].sort())
    } catch {
      setError('Unable to load availability. Please try again later.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSchedule() }, [fetchSchedule])
  useEffect(() => { fetchHoldRequests() }, [fetchHoldRequests])

  const handleLogout = async () => {
    await fetch('/api/client/auth/logout', { method: 'POST' })
    router.replace('/client/login')
  }

  const handleCellRangeSelected = (truckNum: string, start: string, end: string, market: string) => {
    setDraft({ truckNum, start, end, market })
    setDraftNotes('')
    setDraftError('')
  }

  const handleDraftSubmit = async () => {
    if (!draft) return
    setDraftLoading(true)
    setDraftError('')
    try {
      const res = await fetch('/api/client/hold-requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          truck_number: draft.truckNum,
          market:       draft.market,
          start_date:   draft.start,
          end_date:     draft.end,
          notes:        draftNotes || null,
        }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setDraft(null)
      // Optimistically add immediately so cells turn purple without waiting for refetch
      setHoldRequests((prev) => [
        ...prev,
        {
          id:           data.id,
          truck_number: draft.truckNum,
          market:       draft.market,
          state:        '',
          start_date:   draft.start,
          end_date:     draft.end,
          notes:        draftNotes || '',
          status:       'PENDING' as const,
          company_name: clientUser?.companyName || '',
        },
      ])
      fetchHoldRequests()
    } catch {
      setDraftError('Failed to submit. Please try again.')
    } finally {
      setDraftLoading(false)
    }
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
    <div className="flex flex-col h-dvh overflow-hidden">
      {isTestClient ? (
        <ClientHeader clientUser={clientUser} authChecked={authChecked} />
      ) : (
        <header className="bg-[#94ce3a] shadow-lg px-4 sm:px-6 py-3 flex items-center flex-shrink-0">
          <img src="/logo.png" alt="Lime Media" className="h-9 w-auto" />
          <span className="flex-1 text-center text-[#1a3028] font-bold text-lg">Lime Media Scheduling Availability</span>
          <nav className="flex gap-1 items-center">
            <Link href="/client" className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${pathname === '/client' ? 'bg-[#1a3028] text-white' : 'text-[#1a3028] hover:bg-[#1a3028]/20'}`}>Schedule</Link>
            <Link href="/client/map" className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${pathname === '/client/map' ? 'bg-[#1a3028] text-white' : 'text-[#1a3028] hover:bg-[#1a3028]/20'}`}>Map</Link>
            {authChecked && (
              clientUser ? (
                <>
                  <span className="text-[#1a3028] text-xs ml-2 hidden sm:inline">{clientUser.companyName}</span>
                  <button onClick={() => { setPwMsg(null); setShowPwModal(true) }} className="ml-1 px-2 py-1.5 rounded text-xs text-[#1a3028] hover:bg-[#1a3028]/20">Password</button>
                  <button onClick={handleLogout} className="ml-1 px-2 py-1.5 rounded text-xs text-[#1a3028] hover:bg-[#1a3028]/20">Log out</button>
                </>
              ) : (
                <button
                  onClick={async () => {
                    await fetch('/api/client/auth/logout', { method: 'POST' })
                    router.replace('/client/login')
                  }}
                  className="ml-2 px-3 py-1.5 rounded text-sm font-medium bg-[#1a3028] text-white hover:bg-[#1a3028]/90"
                >
                  Log in
                </button>
              )
            )}
          </nav>
        </header>
      )}

      <div className="flex-1 flex flex-col overflow-hidden p-4 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-gray-900">Schedule Grid</h1>
            {authChecked && clientUser && (
              <p className="text-xs text-purple-600 mt-0.5">Drag on available cells to submit a hold request.</p>
            )}
          </div>
          {!loading && <span className="text-xs text-gray-400">{trucks.length} trucks</span>}
        </div>

        <FilterBar
          filters={filters}
          onChange={setFilters}
          markets={markets}
          clientView
          rangeDays={isFirefly(clientUser?.companyName) ? FIREFLY_RANGE_DAYS : DEFAULT_RANGE_DAYS}
        />

        <div className="flex-1 overflow-auto mt-3">
          {error ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <div className="text-5xl mb-4">⚠️</div>
              <p className="text-gray-600 font-medium">{error}</p>
              <button onClick={fetchSchedule} className="mt-4 bg-green-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-800">Retry</button>
            </div>
          ) : loading ? (
            <ScheduleSkeleton />
          ) : (
            <div className="min-w-[900px]">
              <ScheduleGrid
                trucks={trucks}
                schedules={schedules}
                holds={holdBlocks}
                holdRequests={isTestClient ? [...holdRequests, ...otherHoldRequests] : holdRequests}
                filters={filters}
                onHoldCreated={() => {}}
                onCellRangeSelected={clientUser ? handleCellRangeSelected : undefined}
                markets={markets}
                states={states}
                clientView
              />
            </div>
          )}
        </div>
      </div>

      {/* Hold request modal */}
      {draft && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-bold text-gray-900 mb-1">Submit Hold Request</h2>
            <p className="text-sm text-gray-500 mb-4">Your request will be sent to the Lime Media team for review.</p>

            <div className="space-y-2 text-sm mb-4">
              <div className="flex justify-between"><span className="text-gray-500">Truck</span><span className="font-medium">{draft.truckNum}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Market</span><span className="font-medium">{draft.market || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Dates</span><span className="font-medium">{format(parseISO(draft.start), 'MMM d')} – {format(parseISO(draft.end), 'MMM d, yyyy')}</span></div>
            </div>

            <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
            <textarea
              value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              rows={3}
              placeholder="Any additional details…"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
            />

            {draftError && <p className="text-xs text-red-600 mt-2">{draftError}</p>}

            <div className="flex gap-2 mt-4">
              <button onClick={() => setDraft(null)} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={handleDraftSubmit} disabled={draftLoading} className="flex-1 bg-purple-600 text-white py-2 rounded text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
                {draftLoading ? 'Submitting…' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change password modal */}
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
                <button type="button" onClick={() => setShowPwModal(false)} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded text-sm hover:bg-gray-50">Close</button>
                <button type="submit" disabled={pwLoading} className="flex-1 bg-[#1a3028] text-white py-2 rounded text-sm font-medium hover:bg-[#1a3028]/90 disabled:opacity-50">
                  {pwLoading ? 'Saving…' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
