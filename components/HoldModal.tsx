'use client'

import { useState } from 'react'
import { format } from 'date-fns'

interface HoldModalProps {
  truck: string
  startDate: Date
  endDate: Date
  markets: string[]
  onSubmit: (data: {
    client_name: string
    market: string
    state: string
    status: string
    notes: string
  }) => Promise<void>
  onClose: () => void
}

export function HoldModal({ truck, startDate, endDate, markets, onSubmit, onClose }: HoldModalProps) {
  const [form, setForm] = useState({
    client_name: '',
    market: '',
    market_custom: '',
    state: '',
    status: 'HOLD',
    notes: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const resolvedMarket = form.market === '__custom' ? form.market_custom : form.market
  const resolvedState  = form.state

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.client_name) {
      setError('Client name is required')
      return
    }
    if (!resolvedMarket) {
      setError('Market is required')
      return
    }
    setLoading(true)
    try {
      await onSubmit({
        client_name: form.client_name,
        market: resolvedMarket,
        state: resolvedState,
        status: form.status,
        notes: form.notes,
      })
    } catch {
      setError('Failed to place hold')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">Place Hold</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Truck <span className="font-semibold text-gray-700">{truck}</span> &middot;{' '}
            {format(startDate, 'MMM d')}
            {!isSameDay(startDate, endDate) && ` – ${format(endDate, 'MMM d, yyyy')}`}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 text-red-700 text-sm px-3 py-2 rounded border border-red-200">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Client Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.client_name}
              onChange={(e) => setForm({ ...form, client_name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="Enter client name"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Market */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Market <span className="text-red-500">*</span>
              </label>
              <select
                value={form.market}
                onChange={(e) => setForm({ ...form, market: e.target.value, market_custom: '' })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
              >
                <option value="">Select market</option>
                {markets.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="__custom">Other...</option>
              </select>
              {form.market === '__custom' && (
                <input
                  type="text"
                  value={form.market_custom}
                  placeholder="Enter market"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-green-500"
                  onChange={(e) => setForm({ ...form, market_custom: e.target.value })}
                />
              )}
            </div>

            {/* State */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
              <input
                type="text"
                value={form.state}
                placeholder="e.g. TX"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                onChange={(e) => setForm({ ...form, state: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <div className="flex gap-3">
              {(['HOLD', 'COMMITTED'] as const).map((s) => (
                <label key={s} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="status"
                    value={s}
                    checked={form.status === s}
                    onChange={() => setForm({ ...form, status: s })}
                    className="text-green-600"
                  />
                  <span className={`text-sm font-medium ${s === 'HOLD' ? 'text-yellow-700' : 'text-red-700'}`}>
                    {s === 'HOLD' ? 'On Hold' : 'Committed'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
              placeholder="Optional notes..."
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-2 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-green-700 hover:bg-green-800 text-white rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Placing...' : 'Place Hold'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
