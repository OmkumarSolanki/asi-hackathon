import { useApp } from '../lib/store'
import { fmt } from '../lib/format'
import { useTheme } from '../lib/theme'
import { Tooltip } from './ui/Tooltip'

export function Header() {
  const { scenarios, scenarioId, selectScenario, currentTime } = useApp()
  const current = scenarios.find((s) => s.id === scenarioId)
  return (
    <header className="relative z-30 flex items-center gap-6 px-6 py-3 glass hairline-b">
      <Tooltip label="WX Advisory · pilot decision-support tool. Built for the ASI Boston Hackathon.">
        <div className="flex items-center gap-3 cursor-help">
          <div className="flex items-center justify-center w-7 h-7 bg-cyan/10">
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="#00D4FF" strokeWidth="1.5">
              <path d="M12 2 L22 22 L12 17 L2 22 Z" />
            </svg>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-2xs uppercase tracking-wider text-ink-dim">ASI · BOS</span>
            <span className="text-sm tracking-tight">WX Advisory <span className="text-ink-dim font-mono text-2xs ml-1">v0.1</span></span>
          </div>
        </div>
      </Tooltip>

      <div className="w-px h-8 bg-bg-hairline" />

      <div className="flex items-center gap-3">
        <Tooltip label="A scenario = a snapshot of US air traffic + weather forecast at one moment in time. We have 11 of them in our bundle, spanning May 2025 to April 2026.">
          <span className="text-2xs uppercase tracking-wider text-ink-dim cursor-help">Scenario</span>
        </Tooltip>
        <select
          value={scenarioId ?? ''}
          onChange={(e) => selectScenario(e.target.value)}
          className="bg-bg-panel hairline text-readout text-xs px-2.5 py-1.5 focus:outline-none focus:shadow-glow"
        >
          <option value="" disabled>—</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>{fmt.date(s.asked_at)} · {fmt.time(s.asked_at)}</option>
          ))}
        </select>
        {current && (
          <Tooltip label={`${current.n_flights.toLocaleString()} flights filed in the time window. ${current.wx_frames} weather forecast frames (~18 hours ahead, 15-min intervals).`}>
            <span className="text-readout text-2xs text-ink-muted cursor-help">
              {current.n_flights.toLocaleString()} flt · {current.wx_frames} wx
            </span>
          </Tooltip>
        )}
      </div>

      <div className="ml-auto flex items-center gap-6">
        <Clock t={currentTime ?? current?.asked_at ?? null} />
        <ThemeSwitch />
        <StatusDot />
      </div>
    </header>
  )
}

function Clock({ t }: { t: string | null }) {
  if (!t) return null
  return (
    <Tooltip label="The current Zulu (UTC) time the map is showing. Drag the time scrubber to step forward through the forecast.">
      <div className="flex flex-col items-end leading-tight cursor-help">
        <span className="text-2xs uppercase tracking-wider text-ink-dim">Z TIME</span>
        <span className="text-readout text-sm">{fmt.time(t)}</span>
      </div>
    </Tooltip>
  )
}

function ThemeSwitch() {
  const { theme, toggleTheme } = useTheme()
  return (
    <Tooltip label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode (current: ${theme})`}>
      <button
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        className="flex items-center justify-center w-6 h-6 hairline hover:shadow-glow transition-shadow"
      >
        {theme === 'dark' ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#A0AEC0" strokeWidth="1.2">
            <path d="M9.5 7.5 a3.5 3.5 0 1 1 -5-5 c0 3 2 5 5 5z" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#5A6B82" strokeWidth="1.2">
            <circle cx="6" cy="6" r="2.5" />
            <path d="M6 1v1.5M6 9.5V11M11 6h-1.5M2.5 6H1M9.5 2.5l-1 1M3.5 8.5l-1 1M9.5 9.5l-1-1M3.5 3.5l-1-1" />
          </svg>
        )}
      </button>
    </Tooltip>
  )
}

function StatusDot() {
  return (
    <Tooltip label="Backend healthy. The reroute, fuel, crowd-forecast, and analog services are responding." side="left">
      <div className="flex items-center gap-1.5 cursor-help">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-ok opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-ok" />
        </span>
        <span className="text-2xs uppercase tracking-wider text-ink-muted">Live</span>
      </div>
    </Tooltip>
  )
}
