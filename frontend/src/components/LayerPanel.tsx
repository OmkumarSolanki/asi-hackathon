import { useApp, type Layer } from '../lib/store'
import { Tooltip } from './ui/Tooltip'

type Spec = { id: Layer; label: string; hint: string; color: string }

const LAYERS: Spec[] = [
  {
    id: 'weather',
    label: 'Weather',
    color: '#FF6B3D',
    hint: 'Storm radar (HRRR composite reflectivity). Yellow → red → magenta as intensity rises.',
  },
  {
    id: 'winds',
    label: 'Wind',
    color: '#9FE3FF',
    hint: 'Animated wind streamlines flowing across CONUS. Blended from real METAR + climatological field.',
  },
  {
    id: 'sectors',
    label: 'Sectors',
    color: '#00D4FF',
    hint: 'ATC sector boundaries (HIGH band). Outline brightens as sector load nears capacity.',
  },
  {
    id: 'flights',
    label: 'Flights',
    color: '#A0AEC0',
    hint: 'All airborne flights at the scrubbed time, oriented to their heading.',
  },
]

export function LayerPanel() {
  const { layers, toggleLayer, activeFlightId } = useApp()
  // Hide top layer panel when a plane is selected — same toggles already in bottom TimeScrubber.
  if (activeFlightId) return null
  return (
    <div className="absolute top-[60px] right-[88px] z-30 flex flex-col glass hairline shadow-panel min-w-[150px]">
      <div className="px-3 pt-2 pb-1.5 hairline-b badge-bar">
        <span className="text-3xs uppercase tracking-wider text-ink-dim">Layers</span>
      </div>
      <div className="flex flex-col">
        {LAYERS.map((l) => {
          const on = layers[l.id]
          return (
            <Tooltip key={l.id} label={l.hint} side="left">
              <button
                onClick={() => toggleLayer(l.id)}
                className={`flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-cyan/8 ${on ? '' : 'opacity-50'}`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-shadow"
                  style={{
                    background: on ? l.color : 'transparent',
                    boxShadow: on ? `0 0 8px ${l.color}cc, inset 0 0 0 1px ${l.color}` : `inset 0 0 0 1px ${l.color}66`,
                  }}
                />
                <span className={`text-2xs tracking-wider uppercase ${on ? 'text-ink' : 'text-ink-dim'}`}>{l.label}</span>
                <span className="ml-auto text-3xs text-readout text-ink-ghost">{on ? 'ON' : 'OFF'}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
