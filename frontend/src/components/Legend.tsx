import { useApp } from '../lib/store'

export function Legend() {
  const layers = useApp((s) => s.layers)
  const anyOn = layers.weather || layers.winds || layers.sectors || layers.flights
  if (!anyOn) return null

  return (
    <div className="absolute left-1/2 -translate-x-1/2 bottom-[148px] z-30 glass hairline shadow-panel px-3 py-2 flex items-center gap-5 pointer-events-none max-w-[95vw] overflow-x-auto">
      <span className="text-3xs uppercase tracking-wider text-ink-dim flex-shrink-0">Legend</span>
      <div className="w-px h-5 bg-bg-hairline flex-shrink-0" />

      {layers.weather && (
        <Section title="Weather (dBZ)">
          <Swatch color="#00E37A" label="≤40 safe" />
          <Swatch color="#FF3C32" label=">40 hazard" />
        </Section>
      )}

      {layers.winds && (
        <Section title="Wind (kt)">
          <Swatch color="#E6ECF5" label="<25" />
          <Swatch color="#FFB800" label="25–40" />
          <Swatch color="#FF3B30" label="≥40" />
        </Section>
      )}

      {layers.sectors && (
        <Section title="Sector Load">
          <Swatch color="#00D4FF" label="0–60%" />
          <Swatch color="#FFB800" label="60–90%" />
          <Swatch color="#FF3B30" label="90+%" />
        </Section>
      )}

      {layers.flights && (
        <Section title="Aircraft">
          <Plane color="#A0AEC0" label="others" />
          <Plane color="#00D4FF" label="selected" />
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <span className="text-3xs uppercase tracking-wider text-ink-muted">{title}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  )
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="w-2.5 h-2.5 flex-shrink-0"
        style={{ background: color, boxShadow: `0 0 6px ${color}66` }}
      />
      <span className="text-3xs text-readout text-ink">{label}</span>
    </div>
  )
}

function Plane({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <svg width="12" height="12" viewBox="0 0 64 64" className="flex-shrink-0">
        <path
          d="M32 4 L36 28 L60 38 L60 44 L36 40 L36 52 L44 56 L44 60 L32 58 L20 60 L20 56 L28 52 L28 40 L4 44 L4 38 L28 28 Z"
          fill={color}
          stroke="#070A10"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-3xs text-readout text-ink">{label}</span>
    </div>
  )
}

