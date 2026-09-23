const SAMSARA_API_URL = 'https://api.samsara.com/fleet/vehicles/locations'

export interface SamsaraVehicleLocation {
  truck_number:      string
  formatted_address: string
  city:              string
  state:             string
  latitude:          number
  longitude:         number
  time:              string
}

export async function getLiveVehicleLocations(): Promise<Map<string, SamsaraVehicleLocation>> {
  const response = await fetch(SAMSARA_API_URL, {
    headers: {
      'Authorization': `Bearer ${process.env.SAMSARA_API_TOKEN}`,
    },
    next: { revalidate: 0 }, // no cache — always live
  })

  if (!response.ok) {
    throw new Error(`Samsara API error: ${response.status}`)
  }

  const data = await response.json()
  const locationMap = new Map<string, SamsaraVehicleLocation>()

  for (const vehicle of data.data || []) {
    // Only process LED trucks (LED-XXXX or LED XXXX format)
    if (!vehicle.name?.startsWith('LED-') && !vehicle.name?.startsWith('LED ')) continue

    // Pad to 4 digits to match DB truck_number format (e.g. "LED- 825" → "0825", "LED 0766" → "0766")
    const truck_number = vehicle.name.replace(/^LED[-\s]\s*/, '').replace(/^[-\s]+/, '').trim().padStart(4, '0')
    const loc = vehicle.location

    if (!loc?.reverseGeo?.formattedLocation) continue

    const formatted_address = loc.reverseGeo.formattedLocation
    const parts = formatted_address.split(',').map((p: string) => p.trim())
    const stripAdmin = (s: string) => s.replace(/\s+(County|Parish|Borough|Census Area|Municipality|District|Township|Precinct)$/i, '').trim()
    const rawCity = parts[1] || ''
    const parsedCity = stripAdmin(rawCity)
    // When parts[1] is a bare state abbreviation the format is "County, ST" (rural/no city).
    // In that case use parts[0] (the county) as the city name.
    const cityIsState = /^[A-Z]{2}$/.test(parsedCity)
    const city  = cityIsState ? stripAdmin(parts[0]) : parsedCity
    const state = cityIsState ? parsedCity : (parts[2] || '')

    locationMap.set(truck_number, {
      truck_number,
      formatted_address,
      city,
      state,
      latitude:  loc.latitude,
      longitude: loc.longitude,
      time:      loc.time,
    })
  }

  return locationMap
}

const SAMSARA_VEHICLES_URL = 'https://api.samsara.com/fleet/vehicles'

/**
 * VIN for every vehicle in Samsara, keyed by Samsara vehicle id (the value
 * stored in dbo.trucks.samsara_id). The database carries no VIN, so Samsara
 * is the source. Paged 512 at a time.
 */
export async function getVehicleVins(): Promise<Map<string, string>> {
  const vins = new Map<string, string>()
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = new URL(SAMSARA_VEHICLES_URL)
    url.searchParams.set('limit', '512')
    if (after) url.searchParams.set('after', after)
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${process.env.SAMSARA_API_TOKEN}` },
      next: { revalidate: 0 },
    })
    if (!response.ok) throw new Error(`Samsara API error: ${response.status}`)
    const data = await response.json()
    for (const v of data.data || []) {
      if (v?.id && typeof v.vin === 'string' && v.vin.trim()) vins.set(String(v.id), v.vin.trim())
    }
    if (!data.pagination?.hasNextPage || !data.pagination?.endCursor) break
    after = data.pagination.endCursor
  }
  return vins
}
