import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { useApp } from '../lib/store'
import { api } from '../lib/api'
import { fmt } from '../lib/format'
import { Tooltip } from './ui/Tooltip'

export function FlightPicker() {
  const { scenarioId, flights, activeFlightId, selectFlight, jumpToFlightCruise } = useApp()
  const pick = (id: string) => { selectFlight(id); jumpToFlightCruise(id) }
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(true)
  const [hero, setHero] = useState<Array<{ id: string; callsign: string; origin: string; destination: string; encounters: number; max_refc: number }>>([])

  useEffect(() => {
    if (!scenarioId) return
    api.heroFlights(scenarioId, 8).then((r) => setHero(r.flights)).catch(() => setHero([]))
  }, [scenarioId])

  const filtered = useMemo(() => {
    if (!q.trim()) return flights.slice(0, 80)
    const Q = q.toUpperCase()
    return flights.filter(
      (f) => f.callsign.includes(Q) || f.origin.includes(Q) || f.destination.includes(Q),
    ).slice(0, 80)
  }, [flights, q])

  return (
    <aside className="absolute left-4 top-[68px] z-20 w-[320px] glass hairline shadow-panel">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between hairline-b badge-bar">
        <Tooltip label="Every aircraft currently in cruise at the scrubbed time. Click any one to open its advisory channel on the right.">
          <div className="cursor-help">
            <div className="text-2xs uppercase tracking-wider text-ink-dim">Aircraft</div>
            <div className="text-readout text-xs text-ink-muted">{flights.length.toLocaleString()} airborne</div>
          </div>
        </Tooltip>
        <button onClick={() => setOpen(!open)} className="text-2xs tracking-wider text-ink-dim hover:text-ink-muted">
          {open ? '— hide' : '+ show'}
        </button>
      </div>
      <motion.div
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        initial={false}
        className="overflow-hidden"
      >
        {hero.length > 0 && (
          <div className="px-4 pt-3 pb-1">
            <Tooltip label="Flights whose planned routes cross weather cells ≥ 40 dBZ at cruise altitude. These are the best demo subjects — the storm conflict is real and the recommendation will be meaningful.">
              <div className="text-3xs uppercase tracking-wider text-amber mb-1.5 flex items-center gap-1.5 cursor-help">
                <span className="w-1 h-1 bg-amber animate-pulse-soft" /> WX HOTLIST · {hero.length} CONFLICTS
              </div>
            </Tooltip>
            <div className="space-y-0.5 max-h-[140px] overflow-y-auto">
              {hero.map((h) => {
                const active = h.id === activeFlightId
                return (
                  <Tooltip key={h.id} label={`${h.callsign}: planned route crosses ${h.encounters} hazardous weather cell${h.encounters > 1 ? 's' : ''}, peak reflectivity ${h.max_refc.toFixed(0)} dBZ. Click to brief.`} side="right">
                    <button
                      onClick={() => pick(h.id)}
                      className={`w-full flex items-baseline justify-between gap-2 px-2 py-1 text-left text-readout transition-colors ${
                        active ? 'bg-amber/15' : 'hover:bg-bg-divider/60'
                      }`}
                    >
                      <span className={`text-xs ${active ? 'text-amber' : 'text-ink'}`}>{h.callsign}</span>
                      <span className="text-3xs text-ink-muted">{h.origin}→{h.destination}</span>
                      <span className="text-3xs text-amber ml-auto">{h.max_refc.toFixed(0)} dBZ · {h.encounters}×</span>
                    </button>
                  </Tooltip>
                )
              })}
            </div>
            <div className="dotted-divider mt-2" />
          </div>
        )}
        <div className="px-4 pt-3 pb-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="callsign, origin, dest"
            className="w-full bg-bg-divider hairline px-2.5 py-1.5 text-readout text-xs placeholder:text-ink-ghost focus:outline-none focus:shadow-glow"
          />
        </div>
        <div className="max-h-[280px] overflow-y-auto px-2 pb-3">
          {filtered.map((f) => {
            const active = f.id === activeFlightId
            return (
              <button
                key={f.id}
                onClick={() => pick(f.id)}
                className={`w-full flex items-baseline justify-between gap-3 px-2 py-1.5 text-left transition-colors ${
                  active ? 'bg-cyan/10' : 'hover:bg-bg-divider/60'
                }`}
              >
                <span className={`text-readout text-xs ${active ? 'text-cyan' : 'text-ink'}`}>{f.callsign}</span>
                <span className="text-readout text-3xs text-ink-muted">{f.origin}→{f.destination}</span>
                <span className="text-readout text-3xs text-ink-ghost ml-auto">{fmt.fl(f.altitude_ft)}</span>
              </button>
            )
          })}
          {filtered.length === 0 && <div className="text-3xs text-ink-ghost px-3 py-2">No matches.</div>}
        </div>
      </motion.div>
    </aside>
  )
}
