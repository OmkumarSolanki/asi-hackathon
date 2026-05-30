import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { api, type Advisory } from '../lib/api'
import { useApp } from '../lib/store'
import { fmt, verdictBar, verdictColor } from '../lib/format'
import { optionColor, DIRECT_COLOR } from '../lib/colors'
import { Tooltip } from './ui/Tooltip'

export function BriefingPanel() {
  const {
    scenarioId,
    activeFlightId,
    flights,
    currentTime,
    advisory,
    advisoryLoading,
    setAdvisory,
    setAdvisoryLoading,
    setHoveredOption,
    setShowCrowdRoutes,
    selectFlight,
    selectedOptionIds,
    toggleOptionSelection,
    clearOptionSelection,
  } = useApp()
  const flight = flights.find((f) => f.id === activeFlightId)
  const [tab, setTab] = useState<'brief' | 'options' | 'crowd' | 'analogs'>('brief')

  useEffect(() => { setAdvisory(null) }, [activeFlightId, setAdvisory])
  useEffect(() => { setShowCrowdRoutes(tab === 'crowd') }, [tab, setShowCrowdRoutes])

  const handleAdvise = async () => {
    if (!scenarioId || !activeFlightId || !currentTime) return
    setAdvisoryLoading(true)
    try {
      const a = await api.advise(scenarioId, activeFlightId, currentTime)
      setAdvisory(a)
      setTab('brief')
    } finally {
      setAdvisoryLoading(false)
    }
  }

  return (
    <aside className="absolute right-4 top-[68px] bottom-[150px] w-[420px] z-20 flex flex-col">
      <div className="flex-1 overflow-hidden flex flex-col glass hairline shadow-panel">
        <PanelHeader flight={flight} advisory={advisory} onDeselect={() => selectFlight(null)} />

        {!flight && <EmptyState />}

        {flight && !advisory && !advisoryLoading && (
          <FlightSnapshot flight={flight} onRequest={handleAdvise} />
        )}

        {advisoryLoading && <LoadingState />}

        {advisory && (
          <>
            <Tabs tab={tab} setTab={setTab} />
            <div className="flex-1 overflow-y-auto">
              <AnimatePresence mode="wait">
                <motion.div
                  key={tab}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                >
                  {tab === 'brief' && <BriefTab a={advisory} />}
                  {tab === 'options' && (
                    <OptionsTab
                      a={advisory}
                      onHover={setHoveredOption}
                      selectedIds={selectedOptionIds}
                      toggleSelect={toggleOptionSelection}
                      clearSelect={clearOptionSelection}
                    />
                  )}
                  {tab === 'crowd' && <CrowdTab a={advisory} />}
                  {tab === 'analogs' && <AnalogsTab a={advisory} />}
                </motion.div>
              </AnimatePresence>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

function PanelHeader({ flight, advisory, onDeselect }: { flight?: { callsign: string; origin: string; destination: string } | undefined; advisory: Advisory | null; onDeselect: () => void }) {
  return (
    <div className="px-5 pt-4 pb-3 hairline-b badge-bar">
      <div className="flex items-baseline justify-between gap-3">
        <Tooltip label="The advisory channel for the currently selected flight. Think of it as the dispatcher's brief over the radio." side="bottom">
          <div className="cursor-help flex-1 min-w-0">
            <div className="text-2xs uppercase tracking-wider text-ink-dim">Advisory Channel</div>
            <div className="text-readout text-xl tracking-tight mt-0.5 truncate">
              {flight ? flight.callsign : '—'}
              <span className="text-ink-dim ml-2 text-sm">{flight ? `${flight.origin} → ${flight.destination}` : 'awaiting target'}</span>
            </div>
          </div>
        </Tooltip>
        <div className="flex items-center gap-2 flex-shrink-0">
          {advisory && (
            <Tooltip label="Confidence in the recommendation. HIGH ≥ 12 historical analogs · MEDIUM ≥ 4 · LOW = fewer than 4." side="left">
              <span className={`text-2xs tracking-wider px-1.5 py-0.5 hairline cursor-help ${
                advisory.confidence === 'HIGH' ? 'text-ok' : advisory.confidence === 'MEDIUM' ? 'text-amber' : 'text-red'
              }`}>
                {advisory.confidence}
              </span>
            </Tooltip>
          )}
          {flight && (
            <Tooltip label="Deselect this flight and return to the full scenario view." side="left">
              <button
                onClick={onDeselect}
                aria-label="Deselect flight"
                className="w-6 h-6 grid place-items-center hairline text-ink-dim hover:text-red hover:bg-red/10 transition-colors"
              >
                <svg width="9" height="9" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1 1 L7 7 M7 1 L1 7" />
                </svg>
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex-1 grid place-items-center p-10 text-center">
      <div className="space-y-3">
        <div className="text-2xs uppercase tracking-wider text-ink-dim">No flight selected</div>
        <div className="text-sm text-ink-muted leading-relaxed">Tap any flight on the map to open its advisory channel.</div>
        <div className="text-3xs text-ink-ghost mt-6 max-w-[280px] mx-auto leading-relaxed">
          Aircraft routing decisions cost the US system <span className="text-readout text-ink-muted">90,000,000 min</span> of delay per year.
          One pilot. One call. Ten seconds.
        </div>
      </div>
    </div>
  )
}

function FlightSnapshot({ flight, onRequest }: { flight: { callsign: string; origin: string; destination: string; altitude_ft: number; cruise_kt: number }; onRequest: () => void }) {
  return (
    <div className="p-5 space-y-4">
      <Row label="Cruise" value={`${fmt.fl(flight.altitude_ft)} · ${fmt.kt(flight.cruise_kt)}`} tip="Cruise altitude (Flight Level = altitude / 100 ft) and true airspeed in knots. Assumed constant for the whole flight." />
      <Row label="Filed" value={`${flight.origin} → ${flight.destination}`} tip="Origin and destination ICAO codes. All US airports start with K." />
      <div className="dotted-divider my-2" />
      <Tooltip label="Calls POST /advise on the backend. Runs the reroute generator (A*), fuel model (OpenAP), crowd-forecast aggregation, k-NN analog lookup, and the Claude briefing call. Usually ~2 seconds.">
        <button
          onClick={onRequest}
          className="group w-full hairline bg-cyan/10 hover:bg-cyan/20 transition-all duration-200 px-4 py-3 flex items-center justify-between"
        >
          <span className="text-xs uppercase tracking-wider text-cyan">Request Advisory</span>
          <svg width="14" height="14" viewBox="0 0 14 14" className="stroke-cyan transition-transform group-hover:translate-x-0.5">
            <path d="M2 7 L12 7 M8 3 L12 7 L8 11" fill="none" strokeWidth="1.5" />
          </svg>
        </button>
      </Tooltip>
      <p className="text-3xs text-ink-ghost leading-relaxed">
        Returns: ranked route options, fuel deltas, crowd-forecast signal from nearby filed routes, and historical analogs from our 11-day archive.
      </p>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex-1 p-5 space-y-3">
      <div className="text-2xs uppercase tracking-wider text-cyan">Computing</div>
      <div className="space-y-2">
        {['Plotting candidate trajectories', 'Sampling weather grid', 'Sector-load check', 'Crowd-forecast aggregation', 'Analog retrieval', 'Briefing generation'].map((s, i) => (
          <motion.div
            key={s}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.12 }}
            className="flex items-center gap-2 text-readout text-2xs text-ink-muted"
          >
            <span className="w-1 h-1 bg-cyan rounded-full animate-pulse-soft" />
            {s}
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function Tabs({ tab, setTab }: { tab: string; setTab: (t: 'brief' | 'options' | 'crowd' | 'analogs') => void }) {
  const tabs: Array<['brief' | 'options' | 'crowd' | 'analogs', string]> = [
    ['brief', 'Brief'],
    ['options', 'Options'],
    ['crowd', 'Crowd'],
    ['analogs', 'Archive'],
  ]
  return (
    <div className="flex hairline-b px-2">
      {tabs.map(([k, label]) => (
        <button
          key={k}
          onClick={() => setTab(k)}
          className={`px-3 py-2.5 text-2xs uppercase tracking-wider transition-colors relative ${tab === k ? 'text-ink' : 'text-ink-dim hover:text-ink-muted'}`}
        >
          {label}
          {tab === k && <span className="absolute left-1 right-1 -bottom-px h-px bg-cyan" />}
        </button>
      ))}
    </div>
  )
}

function BriefTab({ a }: { a: Advisory }) {
  return (
    <div className="p-5 space-y-5">
      <RecommendationBlock a={a} />
      <div className="dotted-divider" />
      <BriefingText text={a.briefing} />
      <FuelStrip fuel={a.fuel} />
      {a.landing_weather?.available && <LandingStrip m={a.landing_weather} />}
    </div>
  )
}

function RecommendationBlock({ a }: { a: Advisory }) {
  const r = a.recommended_route
  if (!r) {
    return <div className="text-2xs uppercase tracking-wider text-ink-dim">No viable route identified</div>
  }
  return (
    <div>
      <Tooltip label="The single best option, picked by our scoring function: prefers fewer weather encounters, then shortest distance, then no sector violations.">
        <div className="text-2xs uppercase tracking-wider text-ink-dim mb-1 cursor-help">Recommended</div>
      </Tooltip>
      <div className="text-readout text-2xl tracking-tighter leading-none mb-3">{r.label}</div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="ΔFuel" value={fmt.delta(r.fuel_delta_lb, 'lb')} accent={r.fuel_delta_lb > 600 ? 'amber' : 'cyan'} tip="Extra fuel vs. flying direct, in pounds. Computed from the aircraft type's burn rate × extra distance." />
        <Stat label="ΔTime" value={fmt.delta(r.time_delta_min, 'm')} tip="Extra (or saved) flight time vs. flying direct, in minutes. Negative = arrives sooner." />
        <Stat label="Distance" value={fmt.nm(r.distance_nm)} tip="Total distance of the recommended route, in nautical miles." />
      </div>
    </div>
  )
}

function BriefingText({ text }: { text: string }) {
  return (
    <div className="bg-bg-divider/60 hairline p-4 scanlines">
      <div className="flex items-center justify-between mb-2">
        <Tooltip label="ATC-style first-person briefing, the kind a dispatcher would read over the radio. Generated by Claude (Sonnet 4.6) from the same structured data shown elsewhere in this panel — no hallucinated numbers.">
          <span className="text-2xs uppercase tracking-wider text-ink-dim cursor-help">Voice Brief</span>
        </Tooltip>
        <Tooltip label="Generated by Claude. Prompt-cached on the static scenario context to keep latency low." side="left">
          <span className="text-3xs text-ink-ghost cursor-help">CLAUDE</span>
        </Tooltip>
      </div>
      <pre className="text-readout text-2xs leading-relaxed whitespace-pre-wrap text-ink">{text}</pre>
    </div>
  )
}

function FuelStrip({ fuel }: { fuel: Advisory['fuel'] }) {
  const reservePct = Math.max(0, Math.min(1, fuel.reserve_lb / fuel.estimated_at_start_lb))
  const burnedPct = Math.max(0, Math.min(1, fuel.burned_so_far_lb / fuel.estimated_at_start_lb))
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <Tooltip label="Estimated fuel state. Starting fuel = filed distance × burn rate × 1.4 (reserve factor). Burn rate from OpenAP aircraft performance model." side="bottom">
          <span className="text-2xs uppercase tracking-wider text-ink-dim cursor-help">Fuel Budget</span>
        </Tooltip>
        <Tooltip label="Estimated fuel still on board, in pounds. Reserve is what's left after planned trip burn." side="left">
          <span className="text-readout text-2xs text-ink-muted cursor-help">{fmt.lb(fuel.remaining_lb)} remaining</span>
        </Tooltip>
      </div>
      <Tooltip label="Gray bar = fuel burned so far · Amber bar = required reserve (legal minimum to land safely)." side="bottom">
        <div className="relative h-2 bg-bg-divider hairline cursor-help">
          <div className="absolute left-0 top-0 bottom-0 bg-ink-ghost" style={{ width: `${burnedPct * 100}%` }} />
          <div className="absolute right-0 top-0 bottom-0 bg-amber/40" style={{ width: `${reservePct * 100}%` }} />
        </div>
      </Tooltip>
      <div className="mt-1 flex justify-between text-3xs text-ink-ghost text-readout">
        <span>Burned {fmt.lb(fuel.burned_so_far_lb)}</span>
        <span>Reserve {fmt.lb(fuel.reserve_lb)}</span>
      </div>
    </div>
  )
}

function LandingStrip({ m }: { m: NonNullable<Advisory['landing_weather']> }) {
  return (
    <div className="hairline p-3">
      <div className="flex items-center justify-between mb-1">
        <Tooltip label="Surface weather at the destination airport, pulled from historical METAR (NOAA Iowa State Mesonet) for the scenario's actual date/time." side="bottom">
          <span className="text-2xs uppercase tracking-wider text-ink-dim cursor-help">{m.icao} Surface</span>
        </Tooltip>
        <Tooltip label={m.warnings && m.warnings.length > 0 ? `Landing-suitability issues: ${m.warnings.join('; ')}` : 'No warnings — winds and visibility within normal landing limits.'} side="left">
          <span className={`text-2xs cursor-help ${m.warnings && m.warnings.length > 0 ? 'text-amber' : 'text-ok'}`}>
            {m.warnings && m.warnings.length > 0 ? 'DEGRADED' : 'OK'}
          </span>
        </Tooltip>
      </div>
      <Tooltip label="Wind direction (degrees, magnetic from north) @ speed in knots. G## = peak gust. Visibility in statute miles." side="bottom">
        <div className="text-readout text-xs text-ink cursor-help">
          {m.wind_dir_deg != null && m.wind_kt != null ? `${String(Math.round(m.wind_dir_deg)).padStart(3, '0')}° @ ${Math.round(m.wind_kt)} kt` : '—'}
          {m.gust_kt != null ? ` · G${Math.round(m.gust_kt)}` : ''}
          {m.visibility_mi != null ? ` · ${m.visibility_mi}sm` : ''}
        </div>
      </Tooltip>
      {m.metar_raw && <div className="mt-1 text-3xs text-readout text-ink-ghost truncate" title={m.metar_raw}>{m.metar_raw}</div>}
    </div>
  )
}

function Row({ label, value, tip }: { label: string; value: string; tip?: string }) {
  const node = (
    <div className="flex items-baseline justify-between">
      <span className="text-2xs uppercase tracking-wider text-ink-dim">{label}</span>
      <span className="text-readout text-xs text-ink">{value}</span>
    </div>
  )
  if (!tip) return node
  return <Tooltip label={tip}><div className="cursor-help">{node}</div></Tooltip>
}

function Stat({ label, value, accent, tip }: { label: string; value: string; accent?: 'cyan' | 'amber' | 'red' | 'ok'; tip?: string }) {
  const color = accent === 'amber' ? 'text-amber' : accent === 'red' ? 'text-red' : accent === 'ok' ? 'text-ok' : 'text-ink'
  const node = (
    <div className="hairline px-2.5 py-2 bg-bg-divider/40">
      <div className="text-3xs uppercase tracking-wider text-ink-dim mb-0.5">{label}</div>
      <div className={`text-readout text-sm ${color}`}>{value}</div>
    </div>
  )
  if (!tip) return node
  return <Tooltip label={tip}><div className="cursor-help">{node}</div></Tooltip>
}

function OptionsTab({
  a,
  onHover,
  selectedIds,
  toggleSelect,
  clearSelect,
}: {
  a: Advisory
  onHover: (id: string | null) => void
  selectedIds: string[]
  toggleSelect: (id: string) => void
  clearSelect: () => void
}) {
  const selected = a.options.filter((o) => selectedIds.includes(o.id))
  return (
    <div className="p-5 space-y-3">
      {selected.length >= 2 && <CompareStrip selected={selected} all={a.options} onClear={clearSelect} />}
      <Tooltip label="Routes that passed all hard constraints (no weather hit, no sector capacity violation). Tap to mark for compare; pick 2-3 to see fuel/time/distance side-by-side.">
        <div className="text-2xs uppercase tracking-wider text-ink-dim cursor-help flex items-center justify-between">
          <span>Viable</span>
          {selectedIds.length > 0 && (
            <button
              onClick={clearSelect}
              className="text-3xs tracking-wider text-ink-dim hover:text-red transition-colors"
            >
              Clear ({selectedIds.length})
            </button>
          )}
        </div>
      </Tooltip>
      {a.options.map((o) => {
        const color = optionColor(o, a.options)
        const isDirect = o.id === 'direct'
        const isSelected = selectedIds.includes(o.id)
        const maxLoad = o.max_sector_load_pct ?? 0
        const sectorsLabel = o.sectors_transited && o.sectors_transited.length > 0
          ? `${o.sectors_transited.length} sector${o.sectors_transited.length > 1 ? 's' : ''}`
          : '—'
        const sectorTone = maxLoad >= 0.9 ? 'text-red' : maxLoad >= 0.7 ? 'text-amber' : 'text-ink-muted'
        return (
          <Tooltip key={o.id} label={
            `${o.label}: ${fmt.nm(o.distance_nm)} · ${fmt.lb(o.fuel_lb)} fuel · ${fmt.min(o.time_min)}.`
            + (o.weather_encounters > 0 ? ` Passes through ${o.weather_encounters} weather cell(s).` : ' No weather hits.')
            + (o.sectors_transited && o.sectors_transited.length > 0 ? ` Transits ${o.sectors_transited.join(', ')}. Worst sector load ${Math.round(maxLoad * 100)}%.` : '')
            + ' Click to mark for compare.'
          } side="left">
            <button
              onMouseEnter={() => onHover(o.id)}
              onMouseLeave={() => onHover(null)}
              onClick={() => toggleSelect(o.id)}
              className={`block w-full text-left hairline px-4 py-3 transition-colors group ${
                isSelected ? 'bg-cyan/15 ring-1 ring-cyan' : 'hover:bg-cyan/5'
              }`}
            >
              <div className="flex items-center gap-3 mb-1.5">
                <span
                  className={`w-3.5 h-3.5 hairline flex-shrink-0 grid place-items-center ${isSelected ? 'bg-cyan/30' : 'bg-transparent'}`}
                  aria-label={isSelected ? 'Selected for compare' : 'Not selected'}
                >
                  {isSelected && (
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="#00D4FF" strokeWidth="1.5">
                      <path d="M1.5 4 L3.5 6 L7 1.5" />
                    </svg>
                  )}
                </span>
                <span
                  className="inline-block w-6 h-0.5 flex-shrink-0"
                  style={{
                    background: isDirect
                      ? `repeating-linear-gradient(90deg, ${DIRECT_COLOR} 0 3px, transparent 3px 6px)`
                      : color,
                    boxShadow: !isDirect ? `0 0 8px ${color}66` : undefined,
                  }}
                />
                <span className="text-readout text-sm flex-1">{o.label}</span>
                <span className="text-readout text-2xs text-ink-muted">{fmt.nm(o.distance_nm)}</span>
              </div>
              <div className="flex gap-4 text-readout text-2xs text-ink-muted pl-9">
                <span>{fmt.lb(o.fuel_lb)}</span>
                <span>{fmt.min(o.time_min)}</span>
                <span className={o.weather_encounters > 0 ? 'text-amber' : 'text-ok'}>
                  {o.weather_encounters > 0 ? `${o.weather_encounters} wx` : 'clear'}
                </span>
                <span className={sectorTone} title="Sectors transited / worst load">
                  {sectorsLabel} · {Math.round(maxLoad * 100)}%
                </span>
              </div>
              {o.sectors_transited && o.sectors_transited.length > 0 && (
                <div className="mt-1.5 pl-9 flex flex-wrap gap-1">
                  {o.sectors_transited.slice(0, 6).map((s) => (
                    <span key={s} className="text-3xs text-readout text-ink-ghost hairline px-1.5 py-0.5">
                      {s}
                    </span>
                  ))}
                  {o.sectors_transited.length > 6 && (
                    <span className="text-3xs text-ink-ghost">+{o.sectors_transited.length - 6}</span>
                  )}
                </div>
              )}
            </button>
          </Tooltip>
        )
      })}
      <div className="dotted-divider my-3" />
      <Tooltip label="Routes we considered but ruled out. Each carries a specific failure reason (sector full, still hits weather, etc.). Shown on map as dashed red.">
        <div className="text-2xs uppercase tracking-wider text-ink-dim cursor-help">Rejected</div>
      </Tooltip>
      {a.rejected.length === 0 && <div className="text-3xs text-ink-ghost">No rejections this iteration.</div>}
      {a.rejected.map((r) => (
        <Tooltip key={r.id} label={`Rejected reason: ${r.reason ?? 'unspecified'}`} side="left">
          <div className="hairline px-4 py-3 opacity-70 cursor-help">
            <div className="flex items-center gap-3 mb-1">
              <span
                className="inline-block w-6 h-0.5 flex-shrink-0"
                style={{ background: 'repeating-linear-gradient(90deg, rgba(255,59,48,0.7) 0 3px, transparent 3px 6px)' }}
              />
              <span className="text-readout text-xs text-ink-muted line-through flex-1">{r.label}</span>
              {r.fuel_lb != null && <span className="text-readout text-2xs text-ink-ghost">{fmt.lb(r.fuel_lb)}</span>}
            </div>
            <div className="text-3xs text-red pl-9">{r.reason}</div>
          </div>
        </Tooltip>
      ))}
    </div>
  )
}

function CompareStrip({
  selected,
  all,
  onClear,
}: {
  selected: import('../lib/api').RouteOption[]
  all: import('../lib/api').RouteOption[]
  onClear: () => void
}) {
  // Best per metric across selected (lower is better for fuel/time/distance/encounters/load).
  const best = {
    fuel: Math.min(...selected.map((o) => o.fuel_lb)),
    time: Math.min(...selected.map((o) => o.time_min)),
    dist: Math.min(...selected.map((o) => o.distance_nm)),
    wx: Math.min(...selected.map((o) => o.weather_encounters)),
    load: Math.min(...selected.map((o) => o.max_sector_load_pct ?? 0)),
  }
  // Score each on how many metrics it wins (ties count).
  const wins = selected.map((o) => {
    let w = 0
    if (o.fuel_lb === best.fuel) w++
    if (o.time_min === best.time) w++
    if (o.distance_nm === best.dist) w++
    if (o.weather_encounters === best.wx) w++
    if ((o.max_sector_load_pct ?? 0) === best.load) w++
    return w
  })
  const topWins = Math.max(...wins)
  const winner = selected[wins.indexOf(topWins)]

  // Baseline = first option flown (direct), if present, for delta context.
  const baseline = all.find((o) => o.id === 'direct') ?? all[0]

  return (
    <div className="hairline bg-cyan/5 p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-wider text-cyan">Compare ({selected.length})</span>
        <button onClick={onClear} className="text-3xs tracking-wider text-ink-dim hover:text-red transition-colors">
          Clear
        </button>
      </div>
      <div className="text-3xs text-ink-muted leading-snug">
        Most efficient: <span className="text-readout text-ink">{winner.label}</span>
        <span className="text-ink-dim"> · wins {topWins}/5 metrics</span>
      </div>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-3xs text-readout border-collapse">
          <thead>
            <tr className="text-ink-dim">
              <th className="text-left font-normal pl-1 py-1">Option</th>
              <th className="text-right font-normal py-1">Fuel</th>
              <th className="text-right font-normal py-1">Time</th>
              <th className="text-right font-normal py-1">Dist</th>
              <th className="text-right font-normal py-1">Wx</th>
              <th className="text-right font-normal pr-1 py-1">Load</th>
            </tr>
          </thead>
          <tbody>
            {selected.map((o, i) => {
              const isWinner = wins[i] === topWins
              return (
                <tr key={o.id} className={`border-t border-bg-hairline ${isWinner ? 'text-ink' : 'text-ink-muted'}`}>
                  <td className="pl-1 py-1 truncate max-w-[100px]">
                    {isWinner && <span className="text-cyan mr-1">●</span>}
                    {o.label}
                  </td>
                  <td className={`text-right py-1 ${o.fuel_lb === best.fuel ? 'text-ok' : ''}`}>{fmt.lb(o.fuel_lb)}</td>
                  <td className={`text-right py-1 ${o.time_min === best.time ? 'text-ok' : ''}`}>{fmt.min(o.time_min)}</td>
                  <td className={`text-right py-1 ${o.distance_nm === best.dist ? 'text-ok' : ''}`}>{fmt.nm(o.distance_nm)}</td>
                  <td className={`text-right py-1 ${o.weather_encounters === best.wx ? 'text-ok' : 'text-amber'}`}>{o.weather_encounters}</td>
                  <td className={`text-right pr-1 py-1 ${(o.max_sector_load_pct ?? 0) === best.load ? 'text-ok' : ''}`}>{Math.round((o.max_sector_load_pct ?? 0) * 100)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {baseline && winner.id !== baseline.id && (
        <div className="text-3xs text-ink-ghost leading-snug pt-1 hairline-t">
          vs. {baseline.label}:
          <span className="text-readout text-ink ml-2">
            {fmt.delta(winner.fuel_lb - baseline.fuel_lb, 'lb fuel')}
            <span className="text-ink-dim mx-1">·</span>
            {fmt.delta(winner.time_min - baseline.time_min, 'm')}
          </span>
        </div>
      )}
    </div>
  )
}

function CrowdTab({ a }: { a: Advisory }) {
  const c = a.crowd_signal
  const pct = c.n_observed > 0 ? c.n_detoured / c.n_observed : 0
  return (
    <div className="p-5 space-y-5">
      <div>
        <Tooltip label="Aggregate of what nearby flights' filed routes are doing. The airlines' planning systems have already decided whether this weather is worth avoiding. We're surfacing that aggregate decision to the cockpit." side="bottom">
          <div className="text-2xs uppercase tracking-wider text-ink-dim mb-1 cursor-help">Crowd-Forecast Signal</div>
        </Tooltip>
        <Tooltip label={
          c.verdict === 'STRONG NO' ? 'Strong avoid signal: ≥60% of nearby flights detoured around this weather.' :
          c.verdict === 'WEAK NO' ? 'Mixed signal: 30-60% of nearby flights detoured.' :
          c.verdict === 'WEAK GO' ? 'Most nearby flights are flying direct — forecast probably overstating threat.' :
          c.verdict === 'STRONG GO' ? 'Nearly all nearby flights are flying direct — airlines aren\'t worried.' :
          'No nearby flights to learn from.'
        } side="bottom">
          <div className={`text-readout text-3xl tracking-tighter leading-none mt-2 cursor-help ${verdictColor[c.verdict]}`}>{c.verdict}</div>
        </Tooltip>
        <p className="text-xs text-ink-muted mt-2 leading-relaxed">{c.headline}</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <Tooltip label="A 'detour' = a flight whose filed waypoints arc ≥2% further than its great-circle direct path, or carry ≥30 nm of perpendicular offset. We treat that as evidence the planners knew the storm was there.">
            <span className="text-2xs uppercase tracking-wider text-ink-dim cursor-help">Nearby Filed Detours</span>
          </Tooltip>
          <span className="text-readout text-xs text-ink">{c.n_detoured} / {c.n_observed}</span>
        </div>
        <div className="relative h-2 bg-bg-divider hairline">
          <div className={`absolute left-0 top-0 bottom-0 ${verdictBar[c.verdict]}`} style={{ width: `${pct * 100}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Median Detour" value={`${c.median_detour_pct.toFixed(1)}%`} tip="Median extra distance vs. great-circle direct, across all nearby flights. Higher = more flights routing around something." />
        <Stat label="Max Offset" value={fmt.nm(c.max_offset_nm)} tip="The biggest perpendicular distance any nearby flight's filed waypoint is from its great-circle path." />
      </div>

      <div>
        <Tooltip label="Sample of the actual nearby flights and how their filed routes compare to flying direct.">
          <div className="text-2xs uppercase tracking-wider text-ink-dim mb-2 cursor-help">Observed Examples</div>
        </Tooltip>
        <div className="space-y-1.5">
          {c.examples.slice(0, 6).map((ex, i) => (
            <Tooltip key={i} label={ex.is_detour ? `${ex.flight} flies ${ex.detour_pct.toFixed(1)}% further than direct (arc max ${ex.offset_nm} nm).` : `${ex.flight} flies essentially direct — no notable deviation.`} side="left">
              <div className="flex items-baseline justify-between hairline px-3 py-2 cursor-help">
                <div className="text-readout text-2xs text-ink">{ex.flight}<span className="text-ink-dim ml-2 text-3xs">{ex.origin}→{ex.destination}</span></div>
                <div className={`text-readout text-3xs ${ex.is_detour ? 'text-amber' : 'text-ink-muted'}`}>
                  {ex.is_detour ? `+${ex.detour_pct.toFixed(1)}% · ${fmt.nm(ex.offset_nm)} arc` : 'direct'}
                </div>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  )
}

function AnalogsTab({ a }: { a: Advisory }) {
  const x = a.analogs
  return (
    <div className="p-5 space-y-5">
      <div>
        <Tooltip label="PIREP archive: we replayed every flight in every scenario, sampled the weather at its position every 15 min, and logged each hazardous encounter. Then we do k-NN over the weather signature (refc / retop / altitude margin) at query time.">
          <div className="text-2xs uppercase tracking-wider text-ink-dim mb-1 cursor-help">Historical Archive</div>
        </Tooltip>
        <div className="text-readout text-3xl tracking-tighter leading-none">{x.count}</div>
        <p className="text-xs text-ink-muted mt-1 leading-relaxed">similar filed weather encounters across {x.scenarios} scenarios in our 11-day archive.</p>
      </div>

      {x.median_refc != null && (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Median refc" value={`${x.median_refc} dBZ`} tip="50th-percentile reflectivity among the historical analogs. dBZ is logarithmic: 40 = heavy rain, 50+ = severe." />
          <Stat label="P90 refc" value={x.p90_refc != null ? `${x.p90_refc} dBZ` : '—'} tip="90th-percentile reflectivity. If P90 is well above median, some analogs were very severe." />
        </div>
      )}

      {x.records_preview && x.records_preview.length > 0 && (
        <div>
          <Tooltip label="The closest historical matches by weather signature. 'sim' = similarity score (1.0 = identical signature).">
            <div className="text-2xs uppercase tracking-wider text-ink-dim mb-2 cursor-help">Top matches</div>
          </Tooltip>
          <div className="space-y-1.5">
            {x.records_preview.map((r, i) => (
              <Tooltip key={i} label={`${r.flight} (scenario ${r.scenario.slice(0, 10)}) crossed weather of ${r.refc_dbz} dBZ at FL${Math.round(r.alt_ft / 100)}. Signature similarity: ${r.similarity.toFixed(2)}.`} side="left">
                <div className="hairline px-3 py-2 cursor-help">
                  <div className="flex justify-between items-baseline">
                    <span className="text-readout text-2xs text-ink">{r.flight}</span>
                    <span className="text-3xs text-ink-ghost">sim {r.similarity.toFixed(2)}</span>
                  </div>
                  <div className="text-3xs text-readout text-ink-dim mt-0.5">
                    {r.origin}→{r.destination} · refc {r.refc_dbz} · FL{Math.round(r.alt_ft / 100)}
                  </div>
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
