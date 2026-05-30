export const fmt = {
  fl: (alt: number) => `FL${Math.round(alt / 100).toString().padStart(3, '0')}`,
  nm: (n: number) => `${Math.round(n).toLocaleString()} nm`,
  lb: (n: number) => `${Math.round(n).toLocaleString()} lb`,
  min: (n: number) => `${n.toFixed(0)} min`,
  kt: (n: number) => `${Math.round(n)} kt`,
  pct: (n: number) => `${Math.round(n * 100)}%`,
  delta: (n: number, unit: string) => (n >= 0 ? `+${Math.round(n)} ${unit}` : `${Math.round(n)} ${unit}`),
  time: (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + 'Z'
  },
  date: (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase()
  },
}

export const verdictColor: Record<string, string> = {
  'STRONG NO': 'text-red',
  'WEAK NO': 'text-amber',
  'WEAK GO': 'text-amber',
  'STRONG GO': 'text-ok',
  UNKNOWN: 'text-ink-muted',
}

export const verdictBar: Record<string, string> = {
  'STRONG NO': 'bg-red',
  'WEAK NO': 'bg-amber',
  'WEAK GO': 'bg-amber',
  'STRONG GO': 'bg-ok',
  UNKNOWN: 'bg-ink-dim',
}
