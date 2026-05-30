const BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000/api'

export type Scenario = {
  id: string
  asked_at: string
  n_flights: number
  window_start: string
  window_end: string
  wx_frames: number
}

export type Flight = {
  id: string
  callsign: string
  origin: string
  destination: string
  altitude_ft: number
  cruise_kt: number
  take_off_time: string
  scheduled_landing_time: string
  lats: number[]
  lons: number[]
  is_airborne: boolean
}

export type SectorFeature = {
  type: 'Feature'
  geometry: GeoJSON.Geometry
  properties: {
    name: string
    altitude_from_ft: number
    altitude_to_ft: number
    capacity: number
    load: number
    load_pct: number
  }
}

export type WeatherGrid = {
  scenario: string
  kind: string
  time: string
  rows: number
  cols: number
  bbox: { lat_min: number; lat_max: number; lon_min: number; lon_max: number }
  values: (number | null)[]
}

export type RouteOption = {
  id: string
  label: string
  lats: number[]
  lons: number[]
  distance_nm: number
  time_min: number
  fuel_lb: number
  weather_encounters: number
  max_refc_dbz?: number | null
  sector_violations: string[]
  sectors_transited?: string[]
  max_sector_load_pct?: number
}

export type RejectedOption = {
  id: string
  label: string
  reason?: string | null
  distance_nm?: number
  time_min?: number
  fuel_lb?: number
  lats?: number[]
  lons?: number[]
}

export type CrowdSignal = {
  n_observed: number
  n_detoured: number
  median_detour_pct: number
  median_offset_nm: number
  max_offset_nm: number
  verdict: 'STRONG NO' | 'WEAK NO' | 'WEAK GO' | 'STRONG GO' | 'UNKNOWN'
  headline: string
  examples: Array<{
    flight: string
    origin: string
    destination: string
    detour_pct: number
    offset_nm: number
    is_detour: boolean
    alt_ft: number
    filed_lats?: number[]
    filed_lons?: number[]
    gc_lats?: number[]
    gc_lons?: number[]
  }>
}

export type AnalogStats = {
  count: number
  median_refc: number | null
  p90_refc?: number
  scenarios: number
  scenario_list?: string[]
  records_preview?: Array<{
    scenario: string
    flight: string
    origin: string
    destination: string
    time: string
    lat: number
    lon: number
    alt_ft: number
    refc_dbz: number
    retop_ft: number | null
    similarity: number
  }>
}

export type FuelState = {
  estimated_at_start_lb: number
  burned_so_far_lb: number
  remaining_lb: number
  reserve_lb: number
}

export type MetarInfo = {
  available: boolean
  icao?: string
  valid_utc?: string
  wind_kt?: number | null
  wind_dir_deg?: number | null
  gust_kt?: number | null
  visibility_mi?: number | null
  crosswind_kt?: number | null
  metar_raw?: string
  warnings?: string[]
  summary?: string
  note?: string
}

export type Advisory = {
  flight: {
    callsign: string
    aircraft_type: string
    origin: string
    destination: string
    altitude_ft: number
    cruise_kt: number
    current_position: { lat: number; lon: number; phase: string }
    filed_route: { lats: number[]; lons: number[] }
  }
  current_sector: { name: string; capacity: number; altitude_from_ft: number; altitude_to_ft: number } | null
  weather_summary: string
  encounters_ahead: Array<{ time: string; lat: number; lon: number; refc_dbz: number; retop_ft: number | null; severity: string }>
  options: RouteOption[]
  rejected: RejectedOption[]
  recommended_route: { id: string; label: string; distance_nm: number; time_min: number; fuel_lb: number; fuel_delta_lb: number; time_delta_min: number } | null
  crowd_signal: CrowdSignal
  analogs: AnalogStats
  fuel: FuelState
  landing_weather: MetarInfo
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  time: string
  scenario: string
  briefing: string
}

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json() as Promise<T>
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json() as Promise<T>
}

export const api = {
  scenarios: () => jget<{ scenarios: Scenario[] }>('/scenarios'),
  flights: (sid: string, limit = 1500) =>
    jget<{ scenario: string; asked_at: string; count: number; flights: Flight[] }>(
      `/scenarios/${encodeURIComponent(sid)}/flights?airborne_only=true&limit=${limit}`,
    ),
  weather: (sid: string, t: string, kind: 'refc' | 'retop' = 'refc') =>
    jget<WeatherGrid>(`/scenarios/${encodeURIComponent(sid)}/weather?t=${encodeURIComponent(t)}&kind=${kind}`),
  sectors: (sid: string, t: string, band?: 'high' | 'low') =>
    jget<{ type: 'FeatureCollection'; features: SectorFeature[] }>(
      `/scenarios/${encodeURIComponent(sid)}/sectors?t=${encodeURIComponent(t)}${band ? `&band=${band}` : ''}`,
    ),
  winds: (sid: string, t: string) =>
    jget<{ time: string; count: number; stations: Array<{ icao: string; lat: number; lon: number; wind_kt: number; wind_dir_deg: number; gust_kt: number | null }> }>(
      `/scenarios/${encodeURIComponent(sid)}/winds?t=${encodeURIComponent(t)}`,
    ),
  timesteps: (sid: string) =>
    jget<{ scenario: string; kind: string; timesteps: string[] }>(`/scenarios/${encodeURIComponent(sid)}/timesteps`),
  heroFlights: (sid: string, limit = 12) =>
    jget<{ scenario: string; flights: Array<{ id: string; callsign: string; origin: string; destination: string; altitude_ft: number; encounters: number; max_refc: number; drama_score: number }> }>(
      `/scenarios/${encodeURIComponent(sid)}/hero-flights?limit=${limit}`,
    ),
  advise: (scenario: string, flight: string, time: string) =>
    jpost<Advisory>('/advise', { scenario, flight, time }),
}
