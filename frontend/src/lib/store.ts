import { create } from 'zustand'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { Advisory, Flight, Scenario, SectorFeature, WeatherGrid } from './api'

export type Layer = 'weather' | 'sectors' | 'flights' | 'winds'

export type Wind = { icao: string; lat: number; lon: number; wind_kt: number; wind_dir_deg: number; gust_kt?: number | null; source?: 'metar' | 'synthetic' }

type State = {
  scenarios: Scenario[]
  scenarioId: string | null
  flights: Flight[]
  flightsLoaded: boolean
  timesteps: string[]
  currentTime: string | null
  playing: boolean
  layers: Record<Layer, boolean>
  weather: WeatherGrid | null
  sectors: SectorFeature[]
  winds: Wind[]
  activeFlightId: string | null
  advisory: Advisory | null
  advisoryLoading: boolean
  hoveredOption: string | null
  selectedOptionIds: string[]
  showCrowdRoutes: boolean
  mapInstance: MapLibreMap | null

  setScenarios: (s: Scenario[]) => void
  selectScenario: (id: string) => void
  setFlights: (f: Flight[]) => void
  setTimesteps: (ts: string[]) => void
  setTime: (t: string) => void
  togglePlay: () => void
  toggleLayer: (l: Layer) => void
  setWeather: (w: WeatherGrid | null) => void
  setSectors: (s: SectorFeature[]) => void
  setWinds: (w: Wind[]) => void
  selectFlight: (id: string | null) => void
  jumpToFlightCruise: (id: string) => void
  setAdvisory: (a: Advisory | null) => void
  setAdvisoryLoading: (b: boolean) => void
  setHoveredOption: (id: string | null) => void
  toggleOptionSelection: (id: string) => void
  clearOptionSelection: () => void
  setShowCrowdRoutes: (b: boolean) => void
  setMapInstance: (m: MapLibreMap | null) => void
}

export const useApp = create<State>((set) => ({
  scenarios: [],
  scenarioId: null,
  flights: [],
  flightsLoaded: false,
  timesteps: [],
  currentTime: null,
  playing: false,
  layers: { weather: true, sectors: true, flights: true, winds: false },
  weather: null,
  sectors: [],
  winds: [],
  activeFlightId: null,
  advisory: null,
  advisoryLoading: false,
  hoveredOption: null,
  selectedOptionIds: [],
  showCrowdRoutes: false,
  mapInstance: null,

  setScenarios: (s) => set({ scenarios: s }),
  selectScenario: (id) => set({ scenarioId: id, flights: [], flightsLoaded: false, activeFlightId: null, advisory: null }),
  setFlights: (f) => set({ flights: f, flightsLoaded: true }),
  setTimesteps: (ts) => set({ timesteps: ts, currentTime: ts[0] ?? null }),
  setTime: (t) => set({ currentTime: t }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  toggleLayer: (l) => set((s) => ({ layers: { ...s.layers, [l]: !s.layers[l] } })),
  setWeather: (w) => set({ weather: w }),
  setSectors: (s) => set({ sectors: s }),
  setWinds: (w) => set({ winds: w }),
  selectFlight: (id) => set({ activeFlightId: id, advisory: null, selectedOptionIds: [] }),
  jumpToFlightCruise: (id) =>
    set((s) => {
      const fl = s.flights.find((f) => f.id === id)
      if (!fl || !s.timesteps.length) return {}
      const t0 = new Date(fl.take_off_time).getTime()
      const t1 = new Date(fl.scheduled_landing_time).getTime()
      // aim for ~30% through the flight (early cruise, often where weather hits)
      const target = t0 + (t1 - t0) * 0.3
      // pick the timestep closest to target
      const closest = s.timesteps.reduce((best, t) => {
        const d = Math.abs(new Date(t).getTime() - target)
        const bd = Math.abs(new Date(best).getTime() - target)
        return d < bd ? t : best
      }, s.timesteps[0])
      return { currentTime: closest }
    }),
  setAdvisory: (a) => set({ advisory: a }),
  setAdvisoryLoading: (b) => set({ advisoryLoading: b }),
  setHoveredOption: (id) => set({ hoveredOption: id }),
  toggleOptionSelection: (id) =>
    set((s) => {
      const has = s.selectedOptionIds.includes(id)
      if (has) return { selectedOptionIds: s.selectedOptionIds.filter((x) => x !== id) }
      // cap at 3 for readable compare strip
      const next = [...s.selectedOptionIds, id].slice(-3)
      return { selectedOptionIds: next }
    }),
  clearOptionSelection: () => set({ selectedOptionIds: [] }),
  setShowCrowdRoutes: (b) => set({ showCrowdRoutes: b }),
  setMapInstance: (m) => set({ mapInstance: m }),
}))
