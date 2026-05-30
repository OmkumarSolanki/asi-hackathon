import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

export function HelpToggle() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Help"
        className="absolute top-[60px] right-4 z-30 px-2.5 py-1.5 glass hairline text-2xs uppercase tracking-wider text-ink-muted hover:text-cyan transition-colors"
      >
        <span className="text-cyan mr-1">?</span> Help
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-center"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 8, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="glass hairline shadow-panel w-[760px] max-h-[80vh] overflow-y-auto"
            >
              <div className="px-6 pt-5 pb-4 hairline-b badge-bar flex items-baseline justify-between">
                <div>
                  <div className="text-2xs uppercase tracking-wider text-ink-dim">Field Guide</div>
                  <div className="text-readout text-xl tracking-tight">WX Advisory · Legend</div>
                </div>
                <button onClick={() => setOpen(false)} className="text-2xs uppercase tracking-wider text-ink-dim hover:text-ink-muted">
                  Esc / Close
                </button>
              </div>

              <div className="px-6 py-6 grid grid-cols-2 gap-x-8 gap-y-6 text-xs leading-relaxed text-ink-muted">
                <Section title="The Map">
                  <Row swatch={<Swatch kind="storm" />} label="Storm radar" desc="HRRR composite reflectivity (refc). Yellow/orange/red = increasing precipitation intensity, in dBZ." />
                  <Row swatch={<Swatch kind="sector" />} label="ATC sectors" desc="Synthetic airspace boxes. Red/amber tint = nearing capacity. Click time scrubber 'SECTORS' to toggle." />
                  <Row swatch={<Swatch kind="filed" />} label="Filed route" desc="The flight's planned waypoints, as filed with ATC." />
                  <Row swatch={<Swatch kind="gc" />} label="Great-circle" desc="The 'direct' path origin → destination. Used as a baseline for the crowd-forecast signal." />
                  <Row swatch={<Swatch kind="recommended" />} label="Recommended option" desc="The reroute we recommend. Hover any option in the briefing panel to highlight it on the map." />
                  <Row swatch={<Swatch kind="rejected" />} label="Rejected option" desc="Routes we considered and ruled out. Reason shown in the Options tab." />
                </Section>

                <Section title="The Briefing Panel">
                  <Item term="ΔFuel / ΔTime" def="Difference vs. flying direct. + = costs more; − = saves." />
                  <Item term="Crowd-Forecast Signal" def="Aggregates filed routes of nearby flights. If many of them detour around a weather cell, the airlines' planning systems have 'voted' it dangerous. STRONG NO = avoid; STRONG GO = forecast probably overblown." />
                  <Item term="Archive" def="11 scenarios × every flight × every 15 min × every weather encounter. ≈12k records. We do k-NN over the weather signature for similarity." />
                  <Item term="Confidence" def="HIGH ≥ 12 archive analogs · MEDIUM ≥ 4 · LOW otherwise." />
                  <Item term="Voice Brief" def="Claude (Sonnet 4.6) generates the ATC-style first-person briefing. Grounded in the same structured data shown elsewhere in the panel — no hallucinated numbers." />
                </Section>

                <Section title="Aviation Terms">
                  <Item term="dBZ" def="Radar reflectivity unit. <20 = light precipitation, 40 = heavy rain, 50+ = severe / hail." />
                  <Item term="FL### (Flight Level)" def="Altitude in hundreds of feet. FL380 = 38,000 ft." />
                  <Item term="kt (knots)" def="1 nautical mile / hour ≈ 1.151 mph." />
                  <Item term="nm (nautical mile)" def="1.852 km. The aviation unit of distance." />
                  <Item term="ICAO code (KSFO etc.)" def="4-letter airport identifier. US codes all start with K." />
                </Section>

                <Section title="Controls">
                  <Item term="Time scrubber" def="Slide to step forward through the 18-hour forecast horizon. Press play to auto-advance." />
                  <Item term="WX HOTLIST" def="Flights we detected on planned-route weather conflicts in this scenario. Best demo subjects." />
                  <Item term="Request Advisory" def="Calls /advise on the backend: reroutes, fuel, crowd signal, analogs, briefing — all in one shot. ~2 seconds." />
                </Section>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-ink-dim mb-3">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Row({ swatch, label, desc }: { swatch: React.ReactNode; label: string; desc: string }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="mt-0.5 flex-shrink-0">{swatch}</div>
      <div>
        <div className="text-readout text-2xs text-ink uppercase tracking-wider">{label}</div>
        <div className="text-2xs text-ink-muted mt-0.5">{desc}</div>
      </div>
    </div>
  )
}

function Item({ term, def }: { term: string; def: string }) {
  return (
    <div>
      <div className="text-readout text-2xs text-cyan tracking-wide">{term}</div>
      <div className="text-2xs text-ink-muted mt-0.5">{def}</div>
    </div>
  )
}

function Swatch({ kind }: { kind: 'storm' | 'sector' | 'filed' | 'gc' | 'recommended' | 'rejected' }) {
  if (kind === 'storm') {
    return <div className="w-10 h-3" style={{ background: 'linear-gradient(90deg, #00D4FF 0%, #FFB800 50%, #FF3B30 100%)' }} />
  }
  if (kind === 'sector') {
    return <div className="w-10 h-3 hairline" style={{ background: 'rgba(255, 184, 0, 0.18)', border: '1px solid rgba(255, 184, 0, 0.5)' }} />
  }
  if (kind === 'filed') {
    return <div className="w-10 h-px bg-ink" />
  }
  if (kind === 'gc') {
    return <div className="w-10 h-px" style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(160,174,192,0.8) 0 4px, transparent 4px 8px)' }} />
  }
  if (kind === 'recommended') {
    return <div className="w-10 h-0.5 bg-ok" />
  }
  return <div className="w-10 h-px" style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,59,48,0.6) 0 4px, transparent 4px 8px)' }} />
}
