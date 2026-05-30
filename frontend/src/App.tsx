import { useEffect } from 'react'
import { Header } from './components/Header'
import { MapView } from './components/MapView'
import { TimeScrubber } from './components/TimeScrubber'
import { FlightPicker } from './components/FlightPicker'
import { BriefingPanel } from './components/BriefingPanel'
import { HelpToggle } from './components/HelpOverlay'
import { LayerPanel } from './components/LayerPanel'
import { WindStreamlines } from './components/WindStreamlines'
import { Legend } from './components/Legend'
import { api } from './lib/api'
import { useApp } from './lib/store'
import { useApplyTheme } from './lib/theme'

const HERO_SCENARIO = '2025-07-14T22:35:00Z'

export default function App() {
  useApplyTheme()
  const { scenarioId, setScenarios, selectScenario, setFlights, setTimesteps, currentTime, setWeather, setSectors, setWinds, layers } = useApp()

  useEffect(() => {
    api.scenarios().then((d) => {
      setScenarios(d.scenarios)
      const hero = d.scenarios.find((s) => s.id === HERO_SCENARIO) ?? d.scenarios[0]
      if (hero) selectScenario(hero.id)
    })
  }, [setScenarios, selectScenario])

  useEffect(() => {
    if (!scenarioId) return
    api.flights(scenarioId, 1200).then((d) => setFlights(d.flights))
    api.timesteps(scenarioId).then((d) => setTimesteps(d.timesteps))
  }, [scenarioId, setFlights, setTimesteps])

  useEffect(() => {
    if (!scenarioId || !currentTime) return
    let cancelled = false
    api.weather(scenarioId, currentTime).then((w) => {
      if (!cancelled) setWeather(w)
    })
    api.sectors(scenarioId, currentTime).then((s) => {
      if (!cancelled) setSectors(s.features)
    })
    return () => { cancelled = true }
  }, [scenarioId, currentTime, setWeather, setSectors])

  // Winds only fetch when the layer is toggled on (METAR API is slow)
  useEffect(() => {
    if (!scenarioId || !currentTime || !layers.winds) return
    let cancelled = false
    api.winds(scenarioId, currentTime).then((w) => {
      if (!cancelled) setWinds(w.stations)
    }).catch(() => setWinds([]))
    return () => { cancelled = true }
  }, [scenarioId, currentTime, layers.winds, setWinds])

  return (
    <div className="relative h-full w-full gradient-bg overflow-hidden">
      <div className="absolute inset-0 noise opacity-30 pointer-events-none" />
      <Header />
      <main className="absolute inset-0 top-12">
        <MapView />
        <WindStreamlinesWrapper />
        <LayerPanel />
        <FlightPicker />
        <BriefingPanel />
        <Legend />
        <TimeScrubber />
        <HelpToggle />
      </main>
      <CornerMarks />
    </div>
  )
}

function WindStreamlinesWrapper() {
  const map = useApp((s) => s.mapInstance)
  return <WindStreamlines map={map} />
}

function CornerMarks() {
  const Mark = ({ pos }: { pos: string }) => (
    <div className={`absolute ${pos} w-3 h-3 pointer-events-none`}>
      <div className="absolute top-0 left-0 w-3 h-px bg-ink-ghost" />
      <div className="absolute top-0 left-0 w-px h-3 bg-ink-ghost" />
    </div>
  )
  return (
    <>
      <Mark pos="top-2 left-2 rotate-0" />
      <Mark pos="top-2 right-2 rotate-90" />
      <Mark pos="bottom-2 left-2 -rotate-90" />
      <Mark pos="bottom-2 right-2 rotate-180" />
    </>
  )
}
