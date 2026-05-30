import { useEffect, useRef } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { useApp } from '../lib/store'

const PARTICLES = 2400          // density of streamlines
const TRAIL_FADE = 0.965        // higher = longer trails (0.965 ≈ ~30 frames of memory)
const SPEED_SCALE = 0.016       // base movement scale (deg per frame)
const PARTICLE_LIFE = 140       // frames before respawn

type Particle = { lat: number; lon: number; age: number; px: number; py: number }

/**
 * Build a u/v vector field over CONUS that blends:
 *  - climatological westerlies (jet-stream-ish curvature)
 *  - inverse-distance weighting from real METAR points (if any)
 *
 * Returns a function (lat, lon) → { u: kt east, v: kt north }
 */
type WindStation = { lat: number; lon: number; wind_kt: number; wind_dir_deg: number; source?: string }
function makeWindField(stations: WindStation[]) {
  // Pre-convert METAR (direction wind COMES FROM) → vector wind goes TOWARD
  const pts = stations.map((s) => {
    const rad = ((s.wind_dir_deg + 180) * Math.PI) / 180   // direction wind is going
    return {
      lat: s.lat,
      lon: s.lon,
      u: s.wind_kt * Math.sin(rad),   // east component
      v: s.wind_kt * Math.cos(rad),   // north component
      kt: s.wind_kt,
      isReal: s.source === 'metar',
    }
  })

  return (lat: number, lon: number): { u: number; v: number; kt: number } => {
    // Climatological westerly base flow
    const baseDirDeg = 270 + (lat - 38) * 1.5
    const baseSpeed = 12 + Math.max(0, (lat - 30) * 0.4)
    const baseRad = ((baseDirDeg + 180) * Math.PI) / 180
    let u = baseSpeed * Math.sin(baseRad)
    let v = baseSpeed * Math.cos(baseRad)

    // Inverse-distance weighted blend with nearby station observations
    let wsum = 0, uSum = 0, vSum = 0
    for (const p of pts) {
      const dLat = lat - p.lat
      const dLon = (lon - p.lon) * Math.cos((lat * Math.PI) / 180)
      const d2 = dLat * dLat + dLon * dLon
      const w = 1 / (d2 + 0.5)
      wsum += w
      uSum += w * p.u
      vSum += w * p.v
    }
    if (wsum > 0) {
      const realityWeight = 0.55   // station blend
      const ux = uSum / wsum
      const vx = vSum / wsum
      u = u * (1 - realityWeight) + ux * realityWeight
      v = v * (1 - realityWeight) + vx * realityWeight
    }
    const kt = Math.sqrt(u * u + v * v)
    return { u, v, kt }
  }
}

function speedColor(kt: number, alpha = 1): string {
  // Simple binary: green when safe (<40 kt), red when hazardous (≥40 kt)
  if (kt < 40) return `rgba(0, 227, 122, ${alpha})`
  return `rgba(255, 80, 60, ${alpha})`
}

export function WindStreamlines({ map }: { map: MapLibreMap | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number | null>(null)
  const winds = useApp((s) => s.winds)
  const visible = useApp((s) => s.layers.winds)

  useEffect(() => {
    if (!map) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const sizeCanvas = () => {
      const r = map.getContainer().getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(r.width * dpr)
      canvas.height = Math.round(r.height * dpr)
      canvas.style.width = `${r.width}px`
      canvas.style.height = `${r.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    sizeCanvas()

    if (!visible) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (animRef.current) cancelAnimationFrame(animRef.current)
      animRef.current = null
      return
    }

    const wind = makeWindField(winds)

    // Spawn particles uniformly across the visible bounds
    const bounds = map.getBounds()
    const sw = bounds.getSouthWest()
    const ne = bounds.getNorthEast()
    const particles: Particle[] = Array.from({ length: PARTICLES }).map(() => {
      const lat = sw.lat + Math.random() * (ne.lat - sw.lat)
      const lon = sw.lng + Math.random() * (ne.lng - sw.lng)
      return { lat, lon, age: Math.random() * PARTICLE_LIFE, px: 0, py: 0 }
    })

    const respawn = (p: Particle) => {
      const b = map.getBounds()
      p.lat = b.getSouth() + Math.random() * (b.getNorth() - b.getSouth())
      p.lon = b.getWest() + Math.random() * (b.getEast() - b.getWest())
      p.age = 0
    }

    const tick = () => {
      // Fade the previous frame to create the trail effect
      const r = canvas.getBoundingClientRect()
      ctx.globalCompositeOperation = 'destination-in'
      ctx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE})`
      ctx.fillRect(0, 0, r.width, r.height)
      ctx.globalCompositeOperation = 'source-over'

      const b = map.getBounds()
      for (const p of particles) {
        const { u, v, kt } = wind(p.lat, p.lon)
        const prev = map.project([p.lon, p.lat])
        p.px = prev.x
        p.py = prev.y
        // Convert kt to degrees-per-frame (rough but smooth visually)
        const dLat = v * SPEED_SCALE * 0.05
        const dLon = u * SPEED_SCALE * 0.05 / Math.max(Math.cos((p.lat * Math.PI) / 180), 0.3)
        p.lat += dLat
        p.lon += dLon
        p.age += 1
        const cur = map.project([p.lon, p.lat])

        // Drop offscreen / too old
        if (
          p.age > PARTICLE_LIFE ||
          p.lat < b.getSouth() - 1 || p.lat > b.getNorth() + 1 ||
          p.lon < b.getWest() - 1  || p.lon > b.getEast() + 1
        ) {
          respawn(p)
          continue
        }

        const alpha = Math.min(1, kt / 30) * 0.7 + 0.25
        ctx.strokeStyle = speedColor(kt, alpha)
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.moveTo(prev.x, prev.y)
        ctx.lineTo(cur.x, cur.y)
        ctx.stroke()
      }

      animRef.current = requestAnimationFrame(tick)
    }
    tick()

    const onResize = () => sizeCanvas()
    const onMove = () => { /* canvas just stays put; particles use lat/lon → project each frame */ }
    map.on('resize', onResize)
    map.on('move', onMove)
    window.addEventListener('resize', onResize)

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      map.off('resize', onResize)
      map.off('move', onMove)
      window.removeEventListener('resize', onResize)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [map, winds, visible])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ mixBlendMode: 'screen' }}
    />
  )
}
