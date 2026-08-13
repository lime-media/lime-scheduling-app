'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { format, addDays, startOfDay } from 'date-fns'
import type { TruckLocation } from '@/app/api/trucks/locations/route'
import { getMarketCoords } from '@/lib/marketCoordinates'
import { US_STATE_NAMES, US_STATE_ABBREVIATIONS } from '@/lib/usStates'
import { SearchableSelect } from '@/components/SearchableSelect'

type SchedEntry = { truck_number: string; shift_start: string; shift_end: string; market: string; program: string; standard_market_name?: string; state?: string }
type HoldEntry  = { truck_number: string; start_date: string; end_date: string; status: string; market: string; client_name: string }

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: '#16a34a',
  HOLD:          '#ca8a04',
  COMMITTED:     '#dc2626',
  EMPTY:         '#9ca3af',
}

// Client view: available = green, anything booked = gray
const STATUS_COLORS_CLIENT: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: '#9ca3af',
  HOLD:          '#9ca3af',
  COMMITTED:     '#9ca3af',
  EMPTY:         '#16a34a',
}

const STATUS_LABELS: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: 'Scheduled',
  HOLD:          'On Hold',
  COMMITTED:     'Committed',
  EMPTY:         'Available',
}

const STATUS_LABELS_CLIENT: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: 'Booked',
  HOLD:          'Booked',
  COMMITTED:     'Booked',
  EMPTY:         'Available',
}

const STATUS_BADGE: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: 'bg-green-100 text-green-800',
  HOLD:          'bg-yellow-100 text-yellow-800',
  COMMITTED:     'bg-red-100 text-red-800',
  EMPTY:         'bg-gray-100 text-gray-600',
}

const STATUS_BADGE_CLIENT: Record<TruckLocation['status'], string> = {
  SCHEDULED_LED: 'bg-gray-100 text-gray-600',
  HOLD:          'bg-gray-100 text-gray-600',
  COMMITTED:     'bg-gray-100 text-gray-600',
  EMPTY:         'bg-green-100 text-green-800',
}

// ── Custom circular marker icon ───────────────────────────────────────────────

function createMarkerIcon(status: TruckLocation['status'], truckNumber: string, selected: boolean, colorMap = STATUS_COLORS) {
  const color = colorMap[status]
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

// Cluster bubble shown in place of overlapping/nearby pins — bigger clusters get a
// bigger bubble so clients get a sense of fleet density without having to zoom in.
function createClusterIcon(count: number) {
  const size = count >= 50 ? 54 : count >= 20 ? 46 : count >= 10 ? 40 : 34
  const fs   = size >= 46 ? 15 : size >= 40 ? 14 : 12
  const label = count > 99 ? '99+' : String(count)
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;background:#15803d;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${fs}px;font-family:sans-serif;line-height:1;">${label}</div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
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

// ── Clustered truck markers ───────────────────────────────────────────────────
// Groups pins that are within CLUSTER_PIXEL_RADIUS of each other on screen at the
// current zoom. Groups of more than CLUSTER_COUNT_THRESHOLD trucks collapse into a
// single count bubble (so a busy region doesn't turn into an unreadable pile of
// numbers); smaller groups still show every truck's own numbered pin, since that's
// the whole point of the map for a client checking availability.
const CLUSTER_PIXEL_RADIUS   = 45
const CLUSTER_COUNT_THRESHOLD = 15
// Duplicate-coordinate pins (e.g. trucks sharing one market's fallback lat/lng)
// would stack exactly on top of each other — nudge them into a small ring instead.
const DUPLICATE_SPREAD_DEG   = 0.01

function TruckMarkers({
  trucks, colors, labels, clientView, selected, setSelected, todayStr, selectedDate, fmtTime,
}: {
  trucks: TruckLocation[]
  colors: Record<TruckLocation['status'], string>
  labels: Record<TruckLocation['status'], string>
  clientView: boolean
  selected: string | null
  setSelected: (truckNumber: string) => void
  todayStr: string
  selectedDate: string
  fmtTime: (iso: string) => string
}) {
  const map = useMap()
  const [zoom, setZoom] = useState(() => map.getZoom())
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) })

  const groups = useMemo(() => {
    const projected = trucks.map((truck) => ({ truck, pt: map.project([truck.latitude, truck.longitude], zoom) }))
    const used = new Array(projected.length).fill(false)
    const result: TruckLocation[][] = []
    for (let i = 0; i < projected.length; i++) {
      if (used[i]) continue
      const group = [projected[i].truck]
      used[i] = true
      for (let j = i + 1; j < projected.length; j++) {
        if (used[j]) continue
        if (projected[i].pt.distanceTo(projected[j].pt) <= CLUSTER_PIXEL_RADIUS) {
          group.push(projected[j].truck)
          used[j] = true
        }
      }
      result.push(group)
    }
    return result
  }, [trucks, map, zoom])

  const renderTruckMarker = (truck: TruckLocation, position: [number, number]) => (
    <Marker
      key={truck.truck_number}
      position={position}
      icon={createMarkerIcon(truck.status, truck.truck_number, selected === truck.truck_number, colors)}
      eventHandlers={{ click: () => setSelected(truck.truck_number) }}
    >
      <Popup minWidth={210}>
        <div style={{ fontFamily: 'sans-serif', lineHeight: 1.5 }}>
          <p style={{ fontWeight: 700, fontSize: 16, margin: '0 0 6px' }}>{truck.truck_number}</p>
          <span style={{ display: 'inline-block', background: colors[truck.status], color: '#fff', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 99, marginBottom: 8 }}>
            {labels[truck.status]}
          </span>
          {!clientView && truck.program && <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Program:</b> {truck.program}</p>}
          {!clientView && truck.client  && <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Client:</b> {truck.client}</p>}
          {truck.market  && <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Market:</b> {truck.market}</p>}
          {truck.hold_end_date && <p style={{ fontSize: 13, margin: '0 0 2px' }}><b>Hold until:</b> {truck.hold_end_date}</p>}
          <p style={{ fontSize: 12, color: '#666', margin: '4px 0 2px' }}>{truck.formatted_address}</p>
          <p style={{ fontSize: 11, color: '#999', margin: '0 0 8px' }}>
            {selectedDate !== todayStr
              ? `Showing status for ${selectedDate}`
              : `Updated ${fmtTime(truck.last_updated)}`}
          </p>
          <a href={clientView ? '/client' : '/'} style={{ fontSize: 12, color: '#16a34a', textDecoration: 'underline' }}>View in Schedule →</a>
        </div>
      </Popup>
    </Marker>
  )

  return (
    <>
      {groups.map((group) => {
        if (group.length > CLUSTER_COUNT_THRESHOLD) {
          const lat = group.reduce((sum, t) => sum + t.latitude, 0) / group.length
          const lng = group.reduce((sum, t) => sum + t.longitude, 0) / group.length
          return (
            <Marker
              key={`cluster-${group.map((t) => t.truck_number).sort().join('-')}`}
              position={[lat, lng]}
              icon={createClusterIcon(group.length)}
              eventHandlers={{ click: () => map.setView([lat, lng], Math.min(zoom + 3, 16)) }}
            />
          )
        }

        // Small group — show every truck's own pin. Nudge exact-duplicate coordinates
        // (same market fallback point) into a tiny ring so none are hidden underneath.
        const byCoord = new Map<string, TruckLocation[]>()
        for (const truck of group) {
          const key = `${truck.latitude.toFixed(5)},${truck.longitude.toFixed(5)}`
          if (!byCoord.has(key)) byCoord.set(key, [])
          byCoord.get(key)!.push(truck)
        }
        return Array.from(byCoord.values()).flatMap((dupes) => {
          if (dupes.length === 1) return renderTruckMarker(dupes[0], [dupes[0].latitude, dupes[0].longitude])
          const latCorrection = Math.cos((dupes[0].latitude * Math.PI) / 180)
          return dupes.map((truck, i) => {
            const angle = (2 * Math.PI * i) / dupes.length
            return renderTruckMarker(truck, [
              truck.latitude + DUPLICATE_SPREAD_DEG * Math.sin(angle),
              truck.longitude + (DUPLICATE_SPREAD_DEG * Math.cos(angle)) / latCorrection,
            ])
          })
        })
      })}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MapView({ clientView = false }: { clientView?: boolean }) {
  const todayStr = format(startOfDay(new Date()), 'yyyy-MM-dd')
  const maxDate  = format(addDays(startOfDay(new Date()), 14), 'yyyy-MM-dd')

  const [trucks,        setTrucks]        = useState<TruckLocation[]>([])
  const [loading,       setLoading]       = useState(true)
  const [lastUpdated,   setLastUpdated]   = useState<Date | null>(null)
  const [selected,      setSelected]      = useState<string | null>(null)
  const [flyTarget,     setFlyTarget]     = useState<TruckLocation | null>(null)
  const [selectedDate,  setSelectedDate]  = useState(todayStr)
  const [schedEntries,  setSchedEntries]  = useState<SchedEntry[]>([])
  const [holdEntries,   setHoldEntries]   = useState<HoldEntry[]>([])

  const colors = clientView ? STATUS_COLORS_CLIENT : STATUS_COLORS
  const labels = clientView ? STATUS_LABELS_CLIENT : STATUS_LABELS
  const badges = clientView ? STATUS_BADGE_CLIENT  : STATUS_BADGE

  // Filters
  const [showScheduled, setShowScheduled] = useState(true)
  const [showHold,      setShowHold]      = useState(true)
  const [showCommitted, setShowCommitted] = useState(true)
  const [showEmpty,     setShowEmpty]     = useState(true)
  const [stateFilter,   setStateFilter]   = useState('')

  const fetchLocations = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(clientView ? '/api/client/map' : '/api/trucks/locations')
      const data = res.ok ? await res.json() : { trucks: [] }
      setTrucks(data.trucks ?? [])
      setLastUpdated(new Date())
    } catch {
      // keep previous data on transient failures
    } finally {
      setLoading(false)
    }
  }, [clientView])

  useEffect(() => { fetchLocations() }, [fetchLocations])

  // Fetch schedule + hold data for date-based status
  useEffect(() => {
    const url = clientView ? '/api/client/schedule' : '/api/schedule'
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        setSchedEntries(data.schedules ?? [])
        setHoldEntries(data.holds     ?? [])
      })
      .catch(() => {})
  }, [clientView])

  // Compute truck statuses for the selected date (overrides live status for future dates).
  // Mirrors getCellData priority: non-ATT hold > schedule > ATT_SOFT (with voiding) > empty.
  const displayTrucks = useMemo((): TruckLocation[] => {
    if (selectedDate === todayStr || schedEntries.length === 0) return trucks

    // Pre-compute non-ATT schedules per truck — needed to replicate ATT_SOFT voiding logic
    const nonAttScheds = new Map<string, Array<{ shift_start: string; shift_end: string }>>()
    for (const s of schedEntries) {
      if (s.program?.toLowerCase().includes('att')) continue
      if (!nonAttScheds.has(s.truck_number)) nonAttScheds.set(s.truck_number, [])
      nonAttScheds.get(s.truck_number)!.push({ shift_start: s.shift_start, shift_end: s.shift_end })
    }

    const isDriveDay = (s: SchedEntry) => s.program?.toLowerCase().includes('drive day') ?? false

    return trucks.map((t) => {
      // Helper: parse "City, ST" or "632_CityName" into city/state, falling back to GPS values
      const parseCityState = (mkt: string | null | undefined, fallbackState?: string) => {
        if (!mkt) return { city: t.city, state: t.state }
        const idx = mkt.lastIndexOf(', ')
        if (idx >= 1) return { city: mkt.slice(0, idx), state: mkt.slice(idx + 2) }
        // Handle raw ATT market codes like "632_Paducah"
        const rawMatch = mkt.match(/^\d+_(.+)$/)
        if (rawMatch) return { city: rawMatch[1], state: fallbackState || t.state }
        return { city: t.city, state: t.state }
      }

      // Helper: resolve lat/lng for a market string, falling back to GPS
      const pinCoords = (mkt: string | null | undefined, city: string, state: string) => {
        const c = (mkt && getMarketCoords(mkt)) || (city && state && getMarketCoords(`${city}, ${state}`)) || null
        return c ? { latitude: c.lat, longitude: c.lng } : {}
      }

      // 1. Regular (non-ATT) hold — highest priority
      const hold = holdEntries.find(
        (h) => h.truck_number === t.truck_number && h.status !== 'ATT_SOFT' && h.start_date <= selectedDate && h.end_date >= selectedDate
      )
      if (hold) {
        const { city, state } = parseCityState(hold.market)
        return { ...t, ...pinCoords(hold.market, city, state), status: hold.status as 'HOLD' | 'COMMITTED', market: hold.market || null, city, state, program: null, client: hold.client_name || null, hold_end_date: hold.end_date }
      }

      // 2. Schedule block — use standard_market_name for clean city/state display.
      //    Drive-day schedules are transit legs; show the next real working destination instead.
      const schedsOnDate = schedEntries.filter(
        (s) => s.truck_number === t.truck_number && s.shift_start <= selectedDate && s.shift_end >= selectedDate
      )
      if (schedsOnDate.length > 0) {
        const mainSched = schedsOnDate.find((s) => !isDriveDay(s)) ?? schedsOnDate[0]
        let mkt: string | null
        if (isDriveDay(mainSched)) {
          // Only drive days on this date — show the next real working destination
          const nextReal = schedEntries
            .filter((s) => s.truck_number === t.truck_number && s.shift_start > selectedDate && !isDriveDay(s))
            .sort((a, b) => a.shift_start.localeCompare(b.shift_start))[0]
          const fallback = nextReal?.state || mainSched.state
          mkt = (nextReal?.standard_market_name || nextReal?.market) ?? (mainSched.standard_market_name || mainSched.market) ?? null
          const { city, state } = parseCityState(mkt, fallback)
          return { ...t, ...pinCoords(mkt, city, state), status: 'SCHEDULED_LED', market: mkt, city, state, program: mainSched.program || null, client: null, hold_end_date: null }
        } else {
          mkt = mainSched.standard_market_name || mainSched.market || null
        }
        const { city, state } = parseCityState(mkt, mainSched.state)
        return { ...t, ...pinCoords(mkt, city, state), status: 'SCHEDULED_LED', market: mkt, city, state, program: mainSched.program || null, client: null, hold_end_date: null }
      }

      // 3. ATT_SOFT hold — show as Booked only if NOT voided by any non-ATT schedule
      const attHold = holdEntries.find(
        (h) => h.truck_number === t.truck_number && h.status === 'ATT_SOFT' && h.start_date <= selectedDate && h.end_date >= selectedDate
      )
      if (attHold) {
        const truckNonAtt = nonAttScheds.get(t.truck_number) ?? []
        const voided = truckNonAtt.some(
          (s) => s.shift_start <= attHold.end_date && s.shift_end >= attHold.start_date
        )
        if (!voided) {
          const { city, state } = parseCityState(attHold.market)
          return { ...t, ...pinCoords(attHold.market, city, state), status: 'HOLD', market: attHold.market || null, city, state, program: null, client: null, hold_end_date: attHold.end_date }
        }
        // Voided — fall through to EMPTY
      }

      // For departing trucks: show upcoming real working shift market (skip drive days —
      // they're transit legs, not working destinations).
      const nextShift = schedEntries
        .filter((s) => s.truck_number === t.truck_number && s.shift_start > selectedDate && !isDriveDay(s))
        .sort((a, b) => a.shift_start.localeCompare(b.shift_start))[0]

      if (nextShift) {
        const destMarket = nextShift.standard_market_name || nextShift.market || null
        const { city, state } = parseCityState(destMarket, nextShift.state)
        return { ...t, ...pinCoords(destMarket, city, state), status: 'EMPTY', market: destMarket, city, state, program: null, client: null, hold_end_date: null }
      }

      return { ...t, status: 'EMPTY', market: null, program: null, client: null, hold_end_date: null }
    })
  }, [trucks, selectedDate, schedEntries, holdEntries, clientView, todayStr])

  const filtered = displayTrucks.filter((t) => {
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

  // When the date changes, follow the selected truck's pin to its new position
  useEffect(() => {
    if (!selected) return
    const truck = displayTrucks.find(t => t.truck_number === selected)
    if (truck) setFlyTarget(truck)
  }, [selectedDate, displayTrucks, selected])

  function fmtTime(iso: string) {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    } catch { return '' }
  }

  const [panelOpen, setPanelOpen] = useState(false)

  // Shared sidebar/panel content
  const filterControls = (
    <>
      <div className="space-y-1.5">
        {clientView ? (
          <>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} className="rounded" />
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: colors['EMPTY'] }} />
              <span className="text-sm text-gray-700">Available</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showScheduled || showHold}
                onChange={(e) => { setShowScheduled(e.target.checked); setShowHold(e.target.checked) }}
                className="rounded"
              />
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: colors['SCHEDULED_LED'] }} />
              <span className="text-sm text-gray-700">Booked</span>
            </label>
          </>
        ) : (
          ([
            { key: 'SCHEDULED_LED' as const, label: 'Scheduled', checked: showScheduled, set: setShowScheduled },
            { key: 'HOLD'          as const, label: 'On Hold',   checked: showHold,      set: setShowHold      },
            { key: 'COMMITTED'     as const, label: 'Committed', checked: showCommitted, set: setShowCommitted },
            { key: 'EMPTY'         as const, label: 'Available', checked: showEmpty,     set: setShowEmpty     },
          ] as const).map(({ key, label, checked, set }) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="rounded" />
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: colors[key] }} />
              <span className="text-sm text-gray-700">{label}</span>
            </label>
          ))
        )}
      </div>
      <div className="mt-3">
        <SearchableSelect
          value={stateFilter}
          options={US_STATE_ABBREVIATIONS}
          placeholder="All States"
          width="w-full"
          getAliasText={(abbr) => US_STATE_NAMES[abbr]}
          onChange={setStateFilter}
        />
      </div>
      <p className="text-xs text-gray-500 font-medium mt-2">
        {filtered.length} truck{filtered.length !== 1 ? 's' : ''} shown
      </p>
    </>
  )

  const truckList = loading ? (
    <div className="p-4 text-sm text-gray-400">Loading trucks…</div>
  ) : filtered.length === 0 ? (
    <div className="p-4 text-sm text-gray-400">No trucks match filters</div>
  ) : (
    filtered.map((truck) => (
      <button
        key={truck.truck_number}
        onClick={() => { handleSelectTruck(truck); setPanelOpen(false) }}
        className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
          selected === truck.truck_number
            ? 'bg-green-50 border-l-4 border-l-green-600'
            : 'border-l-4 border-l-transparent'
        }`}
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: colors[truck.status] }} />
          <span className="font-semibold text-sm text-gray-900">{truck.truck_number}</span>
          <span className={`ml-auto text-xs px-1.5 py-0.5 rounded font-medium ${badges[truck.status]}`}>
            {labels[truck.status]}
          </span>
        </div>
        <p className="text-xs text-gray-500 pl-4 truncate">
          {truck.city}{truck.state ? `, ${truck.state}` : ''}
        </p>
      </button>
    ))
  )

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex w-full overflow-hidden" style={{ height: '100%' }}>

      {/* ── Desktop sidebar (hidden on mobile) ──────────────────────────────── */}
      <div className="hidden md:flex w-[300px] flex-shrink-0 bg-white border-r border-gray-200 flex-col overflow-hidden">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-bold text-gray-900">Fleet Map</h2>
            <button onClick={fetchLocations} className="text-xs bg-green-700 hover:bg-green-600 text-white px-2.5 py-1 rounded transition-colors">
              Refresh
            </button>
          </div>
          {lastUpdated && (
            <p className="text-xs text-gray-500 mb-3">
              Updated {lastUpdated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
              <input
                type="date"
                min={todayStr}
                max={maxDate}
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value || todayStr)}
                className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
              />
              {selectedDate !== todayStr && (
                <button
                  onClick={() => setSelectedDate(todayStr)}
                  className="text-xs text-green-700 hover:text-green-900 font-medium whitespace-nowrap"
                >
                  Today
                </button>
              )}
          </div>
        </div>
        <div className="p-4 border-b border-gray-200">{filterControls}</div>
        <div className="flex-1 overflow-y-auto">{truckList}</div>
      </div>

      {/* ── Map (full width on mobile, flex-1 on desktop) ───────────────────── */}
      <div className="flex-1 relative">
        <MapContainer center={[39.5, -98.35]} zoom={4} scrollWheelZoom style={{ width: '100%', height: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          <MapFlyTo truck={flyTarget} />
          <TruckMarkers
            trucks={filtered}
            colors={colors}
            labels={labels}
            clientView={clientView}
            selected={selected}
            setSelected={setSelected}
            todayStr={todayStr}
            selectedDate={selectedDate}
            fmtTime={fmtTime}
          />
        </MapContainer>

        {/* ── Mobile bottom sheet ────────────────────────────────────────────── */}
        <div className="md:hidden absolute bottom-0 left-0 right-0 z-[500]">
          {/* Expanded panel */}
          {panelOpen && (
            <div className="bg-white border-t border-gray-200 max-h-[58vh] flex flex-col shadow-2xl">
              {/* Filters */}
              <div className="p-4 border-b border-gray-200 flex-shrink-0">{filterControls}</div>
              {/* Truck list */}
              <div className="flex-1 overflow-y-auto">{truckList}</div>
            </div>
          )}

          {/* Bottom bar — always visible */}
          <button
            onClick={() => setPanelOpen((o) => !o)}
            className="w-full bg-white/95 backdrop-blur-sm border-t border-gray-200 px-4 py-3 flex items-center justify-between shadow-lg"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-gray-400" />
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <div className="w-2 h-2 rounded-full bg-yellow-400" />
                <div className="w-2 h-2 rounded-full bg-red-500" />
              </div>
              <span className="text-sm font-semibold text-gray-900">
                {filtered.length} truck{filtered.length !== 1 ? 's' : ''}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); fetchLocations() }}
                className="text-xs bg-green-700 text-white px-2 py-0.5 rounded"
              >
                Refresh
              </button>
            </div>
            <svg
              className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${panelOpen ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
