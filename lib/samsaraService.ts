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
    // Only process LED trucks (LED-XXXX format)
    if (!vehicle.name?.startsWith('LED-')) continue

    const truck_number = vehicle.name.replace('LED-', '')
    const loc = vehicle.location
    if (!loc?.reverseGeo?.formattedLocation) continue

    const formatted_address = loc.reverseGeo.formattedLocation
    const parts = formatted_address.split(',').map((p: string) => p.trim())
    const city  = parts[1] || ''
    const state = parts[2] || ''

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
