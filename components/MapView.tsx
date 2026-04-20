'use client'

import { useCallback, useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TruckLocation } from '@/app/api/trucks/locations/route'

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: '#16a34a',
  HOLD:          '#ca8a04',
  COMMITTED:     '#dc2626',
  EMPTY:         '#9ca3af',
}

const STATUS_LABELS: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: 'Scheduled',
  HOLD:          'On Hold',
  COMMITTED:     'Committed',
  EMPTY:         'Available',
}

const STATUS_BADGE: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: 'bg-green-100 text-green-800',
  HOLD:          'bg-yellow-100 text-yellow-800',
  COMMITTED:     'bg-red-100 text-red-800',
  EMPTY:         'bg-gray-100 text-gray-600',
}

// ── Custom circular marker icon ───────────────────────────────────────────────

function createMarkerIcon(status: TruckLocation['status'], truckNumber: string, selected: boolean) {
  const color = STATUS_COLORS[status]
  const size  = selected ? 38 : 30
  const fs    = selected ? 10 : 8
  const border = selected
    ? '3px solid white'
    : '2px solid rgba(255,255,255,0.75)'
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:${color};border-radius:50%;border:${border};box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fs}px;font-family:sans-serif;line-height:1;">${truckNumber}</div>`,
    iconSize:    [size, size],
    iconAnchor:  [size / 2, size / 2],
    popupAnchor: [0, -(size / 2) - 4],
  })
}

// ── Fly-to helper (must be inside MapContainer) ───────────────────────────────

function MapFlyTo({ truck }: { truck: TruckLocation | null }) {
  const map = useMap()
  useEffect(() => {
    if (truck) map.flyTo([truck.latitude, truck.longitude], 10, { duration: 1 })
  }, [truck, map])
  return null
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MapView() {
  const [trucks,      setTrucks]      = useState<TruckLocation[]>([])
  const [loading,     setLoading]     = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [selected,    setSelected]    = useState<string | null>(null)
  const [flyTarget,   setFlyTarget]   = useState<TruckLocation | null>(null)

  // Filters
  const [showScheduled, setShowScheduled] = useState(true)
  const [showHold,      setShowHold]      = useState(true)
  const [showCommitted, setShowCommitted] = useState(true)
  const [showEmpty,     setShowEmpty]     = useState(true)
  const [stateFilter,   setStateFilter]   = useState('')

  const fetchLocations = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/trucks/locations')
      const data = res.ok ? await res.json() : { trucks: [] }
      setTrucks(data.trucks ?? [])
      setLastUpdated(new Date())
    } catch {
      // keep previous data on transient failures
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchLocations() }, [fetchLocations])

  const allStates = Array.from(
    new Set(trucks.map((t) => t.state).filter(Boolean))
  ).sort()

  const filtered = trucks.filter((t) => {
    if (!showScheduled && t.status === 'SCHEDULED_LED') return false
    if (!showHold      && t.status === 'HOLD')          return false
    if (!showCommitted && t.status === 'COMMITTED')      return false
    if (!showEmpty     && t.status === 'EMPTY')          return false
    if (stateFilter && t.state !== stateFilter)          return false
    return true
  })

  function handleSelectTruck(truck: TruckLocation) {
    setSelected(truck.truck_number)
    setFlyTarget(truck)
  }

  function fmtTime(iso: string) {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    } catch { return '' }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full overflow-hidden" style={{ height: '100%' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div className="w-[300px] flex-shrink-0 bg-white border-r border-gray-200 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-bold text-gray-900">Fleet Map</h2>
            <button
              onClick={fetchLocations}
              className="text-xs bg-green-700 hover:bg-green-600 text-white px-2.5 py-1 rounded transition-colors"
            >
              Refresh
            </button>
          </div>
          {lastUpdated && (
            <p className="text-xs text-gray-500">
              Updated {lastUpdated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>

        {/* Filters */}
        <div className="p-4 border-b border-gray-200 space-y-3">
          <div className="space-y-1.5">
            {([
              { key: 'SCHEDULED_LED' as const, label: 'Scheduled',  checked: showScheduled, set: setShowScheduled },
              { key: 'HOLD'          as const, label: 'On Hold',    checked: showHold,      set: setShowHold      },
              { key: 'COMMITTED'     as const, label: 'Committed',  checked: showCommitted, set: setShowCommitted },
              { key: 'EMPTY'         as const, label: 'Available',  checked: showEmpty,     set: setShowEmpty     },
            ] as const).map(({ key, label, checked, set }) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => set(e.target.checked)}
                  className="rounded"
                />
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ background: STATUS_COLORS[key] }}
                />
                <span className="text-sm text-gray-700">{label}</span>
              </label>
            ))}
          </div>

          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 bg-white"
          >
            <option value="">All States</option>
            {allStates.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <p className="text-xs text-gray-500 font-medium">
            {filtered.length} truck{filtered.length !== 1 ? 's' : ''} shown
          </p>
        </div>

        {/* Truck list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-sm text-gray-400">Loading trucks…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-gray-400">No trucks match filters</div>
          ) : (
            filtered.map((truck) => (
              <button
                key={truck.truck_number}
                onClick={() => handleSelectTruck(truck)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                  selected === truck.truck_number
                    ? 'bg-green-50 border-l-4 border-l-green-600'
                    : 'border-l-4 border-l-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: STATUS_COLORS[truck.status] }}
                  />
                  <span className="font-semibold text-sm text-gray-900">{truck.truck_number}</span>
                  <span className={`ml-auto text-xs px-1.5 py-0.5 rounded font-medium ${STATUS_BADGE[truck.status]}`}>
                    {STATUS_LABELS[truck.status]}
                  </span>
                </div>
                <p className="text-xs text-gray-500 pl-4 truncate">
                  {truck.city}{truck.state ? `, ${truck.state}` : ''}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div className="flex-1 relative">
        <MapContainer
          center={[39.5, -98.35]}
          zoom={4}
          scrollWheelZoom
          style={{ width: '100%', height: '100%' }}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          <MapFlyTo truck={flyTarget} />

          {filtered.map((truck) => (
            <Marker
              key={truck.truck_number}
              position={[truck.latitude, truck.longitude]}
              icon={createMarkerIcon(truck.status, truck.truck_number, selected === truck.truck_number)}
              eventHandlers={{ click: () => setSelected(truck.truck_number) }}
            >
              <Popup minWidth={210}>
                <div style={{ fontFamily: 'sans-serif', lineHeight: 1.5 }}>
                  <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 6px' }}>{truck.truck_number}</p>
                  <span style={{
                    display: 'inline-block',
                    background: STATUS_COLORS[truck.status],
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 99,
                    marginBottom: 8,
                  }}>
                    {STATUS_LABELS[truck.status]}
                  </span>
                  {truck.program && <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Program:</b> {truck.program}</p>}
                  {truck.client  && <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Client:</b> {truck.client}</p>}
                  {truck.market  && <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Market:</b> {truck.market}</p>}
                  {truck.hold_end_date && (
                    <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Hold until:</b> {truck.hold_end_date}</p>
                  )}
                  <p style={{ fontSize: 12, color: '#666', margin: '4px 0 2px' }}>{truck.formatted_address}</p>
                  <p style={{ fontSize: 11, color: '#999', margin: '0 0 8px' }}>
                    Updated {fmtTime(truck.last_updated)}
                  </p>
                  <a href="/" style={{ fontSize: 12, color: '#16a34a', textDecoration: 'underline' }}>
                    View in Schedule →
                  </a>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  )
}
