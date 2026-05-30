import { useEffect, useMemo, useRef } from 'react'
import { useApp } from '../lib/store'
import { fmt } from '../lib/format'
import { Tooltip } from './ui/Tooltip'

export function TimeScrubber() {
  const {
    timesteps,
    currentTime,
    setTime,
    playing,
    togglePlay,
    layers,
    toggleLayer,
    activeFlightId,
    flights,
    advisory,
    selectFlight,
  } = useApp()

  const flight = flights.find((f) => f.id === activeFlightId) || null

  // Restrict timeline to flight window when a plane is selected.
  const scopedTimesteps = useMemo(() => {
    if (!flight) return timesteps
    const t0 = new Date(flight.take_off_time).getTime()
    const t1 = new Date(flight.scheduled_landing_time).getTime()
    const inWindow = timesteps.filter((t) => {
      const ms = new Date(t).getTime()
      return ms >= t0 && ms <= t1
    })
    return inWindow.length > 0 ? inWindow : timesteps
  }, [flight, timesteps])

  const total = scopedTimesteps.length
  const idx = currentTime ? Math.max(0, scopedTimesteps.indexOf(currentTime)) : 0

  // If selected flight's window doesn't contain current time, snap to first in-window step.
  useEffect(() => {
    if (!flight || total === 0) return
    if (!currentTime || !scopedTimesteps.includes(currentTime)) {
      setTime(scopedTimesteps[0])
    }
  }, [flight, scopedTimesteps, currentTime, setTime, total])

  const ref = useRef<number | null>(null)
  useEffect(() => {
    if (!playing || total === 0) return
    const tick = () => {
      const i = currentTime ? scopedTimesteps.indexOf(currentTime) : 0
      const next = (i + 1) % total
      setTime(scopedTimesteps[next])
    }
    ref.current = window.setInterval(tick, 600)
    return () => {
      if (ref.current) window.clearInterval(ref.current)
    }
  }, [playing, currentTime, scopedTimesteps, total, setTime])

  // Encounter markers (positions along the scoped timeline, 0..1).
  const encounterMarks = useMemo(() => {
    if (!flight || !advisory || total < 2) return []
    const startMs = new Date(scopedTimesteps[0]).getTime()
    const endMs = new Date(scopedTimesteps[total - 1]).getTime()
    if (endMs <= startMs) return []
    return advisory.encounters_ahead
      .map((e) => {
        const ms = new Date(e.time).getTime()
        if (ms < startMs || ms > endMs) return null
        const pos = (ms - startMs) / (endMs - startMs)
        const severity = e.refc_dbz >= 50 ? 'high' : e.refc_dbz >= 40 ? 'mid' : 'low'
        return { time: e.time, pos, dbz: e.refc_dbz, severity }
      })
      .filter((m): m is { time: string; pos: number; dbz: number; severity: 'high' | 'mid' | 'low' } => m !== null)
  }, [flight, advisory, scopedTimesteps, total])

  if (total === 0) return null

  return (
    <div className="absolute bottom-0 left-0 right-0 z-30 px-6 pb-5 pt-3 pointer-events-none">
      <div className="pointer-events-auto glass hairline shadow-panel px-5 pt-4 pb-4 max-w-[1100px] mx-auto">
        <div className="flex items-center gap-5 mb-3">
          <Tooltip label={playing ? 'Pause auto-advance.' : 'Auto-advance the time scrubber (one frame every ~0.6s).'}>
            <button
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className="w-9 h-9 grid place-items-center bg-cyan/10 hover:bg-cyan/20 transition-colors hairline"
            >
              {playing ? (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="#00D4FF"><rect width="3" height="12" /><rect x="7" width="3" height="12" /></svg>
              ) : (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="#00D4FF"><path d="M0 0 L10 6 L0 12 Z" /></svg>
              )}
            </button>
          </Tooltip>

          {flight ? (
            <Tooltip label={`Timeline scoped to ${flight.callsign} (${flight.origin} → ${flight.destination}). Click × to return to full forecast window.`}>
              <div className="flex items-center gap-2 cursor-help">
                <div className="flex flex-col leading-tight">
                  <span className="text-3xs uppercase tracking-wider text-cyan">Plane Timeline · {flight.callsign}</span>
                  <span className="text-readout text-xs text-ink-muted">
                    {fmt.time(scopedTimesteps[0])} → {fmt.time(scopedTimesteps[total - 1])}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    selectFlight(null)
                  }}
                  className="ml-1 w-5 h-5 grid place-items-center hairline text-ink-dim hover:text-red hover:bg-red/10 transition-colors"
                  aria-label="Deselect flight"
                  title="Deselect flight"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M1 1 L7 7 M7 1 L1 7" />
                  </svg>
                </button>
              </div>
            </Tooltip>
          ) : (
            <Tooltip label="The 18-hour forecast horizon for this scenario, in 15-min strips. Slide to step through it.">
              <div className="flex flex-col leading-tight cursor-help">
                <span className="text-3xs uppercase tracking-wider text-ink-dim">Forecast Window</span>
                <span className="text-readout text-xs text-ink-muted">
                  {fmt.time(scopedTimesteps[0])} → {fmt.time(scopedTimesteps[total - 1])}
                </span>
              </div>
            </Tooltip>
          )}

          <div className="flex-1" />

          <LayerToggle label="WX" active={layers.weather} onClick={() => toggleLayer('weather')} hint="HRRR composite reflectivity radar overlay. Green ≤40 dBZ (safe), red >40 dBZ (hazard)." />
          <LayerToggle label="WIND" active={layers.winds} onClick={() => toggleLayer('winds')} hint="Surface wind at 36 major US airports from historical METAR. Arrow points downwind; neutral <25 kt, amber 25-40, red ≥40." />
          <LayerToggle label="SECTORS" active={layers.sectors} onClick={() => toggleLayer('sectors')} hint="ATC sector polygons (HIGH band shown). Color = current load vs capacity. Zoom in to see name + load/capacity labels." />
          <LayerToggle label="FLIGHTS" active={layers.flights} onClick={() => toggleLayer('flights')} hint="All airborne flights' planned routes + current positions at the scrubbed time." />

          <Tooltip label={flight ? 'Time elapsed since this flight\'s take-off.' : "Time elapsed since the scenario's asked_at (the 'now' moment of the snapshot)."}>
            <div className="flex flex-col items-end leading-tight ml-4 cursor-help">
              <span className="text-3xs uppercase tracking-wider text-ink-dim">T+</span>
              <span className="text-readout text-xs text-ink">
                {Math.round((idx * 15) / 60)}h{((idx * 15) % 60).toString().padStart(2, '0')}m
              </span>
            </div>
          </Tooltip>
        </div>

        <div className="relative h-12">
          {/* Encounter markers above the slider */}
          {encounterMarks.length > 0 && (
            <div className="absolute inset-x-0 top-0 h-4 pointer-events-none">
              {encounterMarks.map((m, i) => {
                const color = m.severity === 'high' ? '#FF3B30' : m.severity === 'mid' ? '#FFB800' : '#00D4FF'
                return (
                  <Tooltip key={i} label={`Weather encounter at ${fmt.time(m.time)} · ${Math.round(m.dbz)} dBZ. Click to jump.`}>
                    <button
                      onClick={() => {
                        // snap to nearest scoped timestep
                        const targetMs = new Date(m.time).getTime()
                        const nearest = scopedTimesteps.reduce((best, t) => {
                          const d = Math.abs(new Date(t).getTime() - targetMs)
                          const bd = Math.abs(new Date(best).getTime() - targetMs)
                          return d < bd ? t : best
                        }, scopedTimesteps[0])
                        setTime(nearest)
                      }}
                      className="absolute -translate-x-1/2 pointer-events-auto cursor-pointer"
                      style={{ left: `${m.pos * 100}%`, top: 0 }}
                      aria-label={`Jump to weather encounter at ${fmt.time(m.time)}`}
                    >
                      <svg width="10" height="14" viewBox="0 0 10 14" className="block">
                        <path d="M5 0 L9 7 L5 14 L1 7 Z" fill={color} stroke="#070A10" strokeWidth="1" />
                      </svg>
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          )}
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-bg-hairline" />
          <input
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={idx}
            onChange={(e) => setTime(scopedTimesteps[Number(e.target.value)])}
            title="Drag to step through the timeline"
            className="absolute inset-x-0 top-3 bottom-2 w-full appearance-none bg-transparent cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-7
              [&::-webkit-slider-thumb]:bg-cyan [&::-webkit-slider-thumb]:shadow-glow [&::-webkit-slider-thumb]:cursor-grab
              [&::-webkit-slider-thumb]:rounded-none"
          />
          <div className="absolute inset-x-0 bottom-0 flex justify-between px-0 pointer-events-none">
            {scopedTimesteps.filter((_, i) => i % Math.max(1, Math.floor(total / 6)) === 0).map((t) => (
              <span key={t} className="text-3xs text-readout text-ink-ghost">{fmt.time(t).replace('Z', '')}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function LayerToggle({ label, active, onClick, hint }: { label: string; active: boolean; onClick: () => void; hint: string }) {
  return (
    <Tooltip label={hint}>
      <button
        onClick={onClick}
        className={`px-2.5 py-1.5 text-3xs tracking-wider hairline transition-colors ${active ? 'bg-cyan/10 text-cyan' : 'text-ink-dim hover:text-ink-muted'}`}
      >
        <span className="font-mono">{active ? '◆' : '◇'}</span> <span className="uppercase">{label}</span>
      </button>
    </Tooltip>
  )
}
