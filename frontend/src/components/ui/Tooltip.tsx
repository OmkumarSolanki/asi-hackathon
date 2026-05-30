import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

type Side = 'top' | 'bottom' | 'left' | 'right'

export function Tooltip({
  label,
  side = 'top',
  delay = 250,
  maxWidth = 240,
  children,
  className,
}: {
  label: ReactNode
  side?: Side
  delay?: number
  maxWidth?: number
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<number | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; transform: string }>({ top: 0, left: 0, transform: '' })

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
  }, [])

  const show = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const el = wrapRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      let top = 0, left = 0, transform = ''
      const gap = 8
      switch (side) {
        case 'top':
          top = r.top - gap
          left = r.left + r.width / 2
          transform = 'translate(-50%, -100%)'
          break
        case 'bottom':
          top = r.bottom + gap
          left = r.left + r.width / 2
          transform = 'translate(-50%, 0)'
          break
        case 'left':
          top = r.top + r.height / 2
          left = r.left - gap
          transform = 'translate(-100%, -50%)'
          break
        case 'right':
          top = r.top + r.height / 2
          left = r.right + gap
          transform = 'translate(0, -50%)'
          break
      }
      setPos({ top, left, transform })
      setOpen(true)
    }, delay)
  }
  const hide = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    setOpen(false)
  }

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={className}
      >
        {children}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: side === 'top' ? 4 : side === 'bottom' ? -4 : 0, x: side === 'left' ? 4 : side === 'right' ? -4 : 0 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: pos.transform,
              maxWidth,
              pointerEvents: 'none',
              zIndex: 9999,
            }}
            className="glass hairline px-2.5 py-1.5 text-2xs text-ink leading-snug shadow-panel"
          >
            {label}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

export function InfoDot({ label, side = 'top' }: { label: ReactNode; side?: Side }) {
  return (
    <Tooltip label={label} side={side}>
      <span className="inline-flex items-center justify-center w-3 h-3 hairline text-3xs text-ink-dim hover:text-ink-muted cursor-help">
        ?
      </span>
    </Tooltip>
  )
}
