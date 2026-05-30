import { useEffect, useLayoutEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'
import { useApp } from '../lib/store'
import { api } from '../lib/api'
import { optionColor } from '../lib/colors'
import { useTheme } from '../lib/theme'

const STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    bg: {
      type: 'raster',
      tiles: [
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OSM',
    },
  },
  layers: [
    { id: 'bg-fill', type: 'background', paint: { 'background-color': '#070A10' } },
  ],
}

const THEME_MAP_BG = { dark: '#070A10', light: '#E8EDF3' } as const
const THEME_FLIGHTS_DOT = { dark: '#A0AEC0', light: '#4A5670' } as const
const THEME_ACTIVE_LABEL_HALO = { dark: '#070A10', light: '#FFFFFF' } as const
const THEME_ROUTES_FAINT = { dark: 'rgba(160, 174, 192, 0.12)', light: 'rgba(74, 86, 112, 0.22)' } as const
const THEME_ACTIVE_LINE = { dark: '#F2F5F9', light: '#0B1320' } as const
const THEME_GC_LINE = { dark: 'rgba(160, 174, 192, 0.7)', light: 'rgba(11, 19, 32, 0.45)' } as const

// Binary radar: ≤40 dBZ green, >40 dBZ red. Hide nodata only — show all precip.
const WX_HAZARD_DBZ = 40
function gridToDataURL(values: (number | null)[], rows: number, cols: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(cols, rows)
  for (let i = 0; i < rows * cols; i++) {
    const v = values[i]
    if (v == null || v < 5) { img.data[i * 4 + 3] = 0; continue }
    let r: number, g: number, b: number, alpha: number
    if (v <= WX_HAZARD_DBZ) {
      r = 0; g = 227; b = 122
      // Alpha climbs with intensity so green stays visible at light precip too.
      alpha = v < 15 ? 150 : v < 25 ? 190 : v < 35 ? 220 : 240
    } else {
      r = 255; g = 60; b = 50
      alpha = v < 50 ? 240 : 255
    }
    img.data[i * 4] = r
    img.data[i * 4 + 1] = g
    img.data[i * 4 + 2] = b
    img.data[i * 4 + 3] = alpha
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

function greatCirclePoints(lat1: number, lon1: number, lat2: number, lon2: number, n = 32): number[][] {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const p1 = toRad(lat1), p2 = toRad(lat2)
  const l1 = toRad(lon1), l2 = toRad(lon2)
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2))
  if (d === 0) return [[lon1, lat1], [lon2, lat2]]
  const out: number[][] = []
  for (let i = 0; i <= n; i++) {
    const f = i / n
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2)
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2)
    const z = A * Math.sin(p1) + B * Math.sin(p2)
    out.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))])
  }
  return out
}


export function MapView() {
  const ref = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const initedRef = useRef(false)

  const { weather, sectors, flights, layers, activeFlightId, advisory, currentTime, selectFlight, hoveredOption, showCrowdRoutes, winds, setMapInstance } = useApp()
  const theme = useTheme((s) => s.theme)

  useEffect(() => {
    if (!ref.current || initedRef.current) return
    initedRef.current = true
    const map = new maplibregl.Map({
      container: ref.current,
      style: STYLE,
      center: [-98, 39],
      zoom: 4,
      attributionControl: false,
      maxZoom: 11,
      minZoom: 3,
      maxBounds: [
        [-145, 15],
        [-55, 60],
      ],
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'bottom-right')
    mapRef.current = map
    setMapInstance(map)
    // Plane icon SVGs (loaded inside the map's load handler so addImage always succeeds)
    const planePath = 'M32 4 L36 28 L60 38 L60 44 L36 40 L36 52 L44 56 L44 60 L32 58 L20 60 L20 56 L28 52 L28 40 L4 44 L4 38 L28 28 Z'
    const planeSvg = (fill: string, stroke: string) =>
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path d='${planePath}' fill='${fill}' stroke='${stroke}' stroke-width='2.5' stroke-linejoin='round'/></svg>`

    map.on('load', () => {
      // Load both plane icon variants (cyan = active, gray = others)
      const loadPlane = (name: string, svg: string, size = 64) => {
        return new Promise<void>((resolve) => {
          const img = new Image(size, size)
          img.onload = () => {
            if (!map.hasImage(name)) {
              try { map.addImage(name, img as unknown as ImageBitmap, { pixelRatio: 2 }) } catch { /* ignore */ }
            }
            resolve()
          }
          img.onerror = () => resolve()
          img.src = `data:image/svg+xml;base64,${btoa(svg)}`
        })
      }
      void loadPlane('plane-icon',     planeSvg('#00D4FF', '#070A10'))
      void loadPlane('plane-icon-dim', planeSvg('#A0AEC0', '#070A10'))
      // Sectors
      map.addSource('sectors', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'sectors-fill',
        type: 'fill',
        source: 'sectors',
        paint: {
          'fill-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'load_pct'], 0],
            0,   'rgba(0, 212, 255, 0.10)',
            0.3, 'rgba(0, 212, 255, 0.20)',
            0.6, 'rgba(255, 184, 0, 0.35)',
            0.9, 'rgba(255, 59, 48, 0.50)',
            1.2, 'rgba(255, 59, 48, 0.65)',
          ],
        },
      })
      map.addLayer({
        id: 'sectors-line',
        type: 'line',
        source: 'sectors',
        paint: {
          'line-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'load_pct'], 0],
            0,   'rgba(0, 212, 255, 0.85)',
            0.6, 'rgba(255, 184, 0, 0.95)',
            1,   'rgba(255, 59, 48, 1.0)',
          ],
          'line-width': [
            'interpolate', ['linear'], ['coalesce', ['get', 'load_pct'], 0],
            0, 1.2,
            0.6, 1.8,
            1, 2.6,
          ],
        },
      })
      // Sector name label at large zooms
      map.addLayer({
        id: 'sectors-label',
        type: 'symbol',
        source: 'sectors',
        minzoom: 5.5,
        layout: {
          'text-field': [
            'format',
            ['get', 'name'], { 'font-scale': 1.0 },
            '\n', {},
            ['concat', ['to-string', ['get', 'load']], '/', ['to-string', ['get', 'capacity']]],
            { 'font-scale': 0.85 },
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': 10,
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#F2F5F9',
          'text-halo-color': '#070A10',
          'text-halo-width': 1.5,
          'text-opacity': [
            'interpolate', ['linear'], ['coalesce', ['get', 'load_pct'], 0],
            0, 0.35,
            0.6, 0.85,
            1, 1,
          ],
        },
      })

      // Weather raster overlay
      map.addSource('wx', {
        type: 'image',
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
        coordinates: [
          [-135.0, 55.7765],
          [-67.5, 55.7765],
          [-67.5, 21.943],
          [-135.0, 21.943],
        ],
      })
      map.addLayer({
        id: 'wx-layer',
        type: 'raster',
        source: 'wx',
        paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 200, 'raster-resampling': 'linear' },
      })

      // Flight routes (all)
      map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'routes-line',
        type: 'line',
        source: 'routes',
        paint: {
          'line-color': 'rgba(160, 174, 192, 0.12)',
          'line-width': 0.5,
        },
      })

      // Active flight route — split into 'behind' (already flown, faded) and 'ahead' (cyan, prominent)
      map.addSource('active-route-behind', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'active-line-behind',
        type: 'line',
        source: 'active-route-behind',
        paint: {
          'line-color': 'rgba(160, 174, 192, 0.55)',
          'line-width': 1.2,
          'line-dasharray': [1, 2],
        },
      })
      map.addSource('active-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'active-line',
        type: 'line',
        source: 'active-route',
        paint: { 'line-color': '#00D4FF', 'line-width': 2.4, 'line-opacity': 0.95 },
      })

      // Great-circle baseline ("direct" path the route deviates from)
      map.addSource('gc-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'gc-line',
        type: 'line',
        source: 'gc-route',
        paint: {
          'line-color': 'rgba(160, 174, 192, 0.7)',
          'line-width': 1,
          'line-dasharray': [3, 3],
        },
      })

      // Advisory options
      map.addSource('options', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'options-line',
        type: 'line',
        source: 'options',
        paint: {
          'line-color': [
            'match', ['get', 'id'],
            'direct', '#FFFFFF',
            ['get', 'color'],
          ],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hovered'], false], 3.2,
            2,
          ],
          'line-dasharray': [
            'case',
            ['==', ['get', 'id'], 'direct'], ['literal', [2, 2]],
            ['literal', [1, 0]],
          ],
        },
      })

      // Rejected options
      map.addSource('rejected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'rejected-line',
        type: 'line',
        source: 'rejected',
        paint: {
          'line-color': 'rgba(255, 59, 48, 0.35)',
          'line-width': 1.2,
          'line-dasharray': [3, 3],
        },
      })

      // All other flights — actual plane silhouettes, rotated by heading, zoom-responsive
      map.addSource('flight-positions', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      // Invisible larger hit-target so hovers/clicks are easy
      map.addLayer({
        id: 'flight-points',
        type: 'circle',
        source: 'flight-positions',
        paint: {
          'circle-radius': 10,
          'circle-color': '#000',
          'circle-opacity': 0,
        },
      })
      map.addLayer({
        id: 'flight-icons',
        type: 'symbol',
        source: 'flight-positions',
        layout: {
          'icon-image': 'plane-icon-dim',
          'icon-rotate': ['coalesce', ['get', 'heading'], 0],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            3, 0.10,
            5, 0.16,
            7, 0.26,
            9, 0.40,
          ],
        },
        paint: {
          'icon-opacity': 0.85,
        },
      })

      // Wind arrows at airport METAR stations (toggleable)
      map.addSource('winds', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'winds-arrow',
        type: 'symbol',
        source: 'winds',
        layout: {
          'text-field': '➤',
          'text-font': ['Open Sans Semibold'],
          // Smaller, more aviation-map-like barbs.
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 14, 5, 18, 7, 24],
          // METAR wind dir = direction wind COMES FROM. Arrow points downwind (+90 because ➤ is east-facing, not north).
          'text-rotate': ['+', ['coalesce', ['get', 'wind_dir_deg'], 0], 90],
          'text-rotation-alignment': 'map',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          // Neutral white base; red only at hazard threshold (≥40 kt).
          'text-color': [
            'step', ['coalesce', ['get', 'wind_kt'], 0],
            '#E6ECF5',
            25, '#FFB800',
            40, '#FF3B30',
          ],
          'text-halo-color': '#070A10',
          'text-halo-width': 1.8,
          'text-opacity': [
            'case',
            ['==', ['get', 'source'], 'synthetic'], 0.45,
            0.85,
          ],
        },
      })
      map.addLayer({
        id: 'winds-label',
        type: 'symbol',
        source: 'winds',
        minzoom: 5,
        layout: {
          'text-field': [
            'concat',
            ['get', 'icao'], '  ',
            ['to-string', ['round', ['coalesce', ['get', 'wind_kt'], 0]]], 'kt',
          ],
          'text-font': ['Open Sans Semibold'],
          'text-size': 9,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#A0AEC0',
          'text-halo-color': '#070A10',
          'text-halo-width': 1.5,
        },
      })

      // Crowd-routes (nearby flights' filed paths shown when Crowd tab active)
      map.addSource('crowd-filed', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'crowd-filed-line',
        type: 'line',
        source: 'crowd-filed',
        paint: {
          'line-color': [
            'case',
            ['boolean', ['get', 'is_detour'], false], '#FFB800',
            'rgba(160,174,192,0.45)',
          ],
          'line-width': [
            'case',
            ['boolean', ['get', 'is_detour'], false], 1.6,
            1.0,
          ],
          'line-opacity': 0.85,
        },
      })
      // Crowd great-circle baselines (dashed gray)
      map.addSource('crowd-gc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'crowd-gc-line',
        type: 'line',
        source: 'crowd-gc',
        paint: {
          'line-color': 'rgba(160,174,192,0.6)',
          'line-width': 0.8,
          'line-dasharray': [2, 2],
          'line-opacity': 0.55,
        },
      })

      // Active flight position — highly visible: halo + core + arrow
      map.addSource('active-position', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection })
      map.addLayer({
        id: 'active-halo-outer',
        type: 'circle',
        source: 'active-position',
        paint: {
          'circle-radius': 22,
          'circle-color': '#00D4FF',
          'circle-opacity': 0.10,
        },
      })
      map.addLayer({
        id: 'active-halo',
        type: 'circle',
        source: 'active-position',
        paint: {
          'circle-radius': 12,
          'circle-color': '#00D4FF',
          'circle-opacity': 0.25,
          'circle-stroke-color': '#00D4FF',
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.6,
        },
      })
      map.addLayer({
        id: 'active-core',
        type: 'circle',
        source: 'active-position',
        paint: {
          'circle-radius': 5,
          'circle-color': '#00D4FF',
          'circle-stroke-color': '#0a0e14',
          'circle-stroke-width': 1.5,
        },
      })
      // Active plane silhouette (rotates with flight heading, scales with zoom)
      map.addLayer({
        id: 'active-heading',
        type: 'symbol',
        source: 'active-position',
        layout: {
          'icon-image': 'plane-icon',
          'icon-rotate': ['coalesce', ['get', 'heading'], 0],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            3, 0.30,
            5, 0.45,
            7, 0.70,
            9, 1.00,
          ],
        },
      })
      // Callsign label
      map.addLayer({
        id: 'active-label',
        type: 'symbol',
        source: 'active-position',
        layout: {
          'text-field': ['get', 'callsign'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-offset': [0, -2.2],
          'text-anchor': 'bottom',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#00D4FF',
          'text-halo-color': '#070A10',
          'text-halo-width': 2,
        },
      })

      // Click handler — pick a flight
      map.on('click', 'routes-line', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const id = f.properties?.id as string
        if (id) selectFlight(id)
      })
      map.on('click', 'flight-points', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const id = f.properties?.id as string
        if (id) selectFlight(id)
      })
      map.on('mouseenter', 'routes-line', () => (map.getCanvas().style.cursor = 'pointer'))
      map.on('mouseleave', 'routes-line', () => (map.getCanvas().style.cursor = ''))

      // Hover popup for flight points — shows callsign
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })
      map.on('mouseenter', 'flight-points', (e) => {
        map.getCanvas().style.cursor = 'pointer'
        const f = e.features?.[0]
        if (!f) return
        const cs = f.properties?.callsign as string
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number]
        popup.setLngLat(coords).setHTML(`<div style="font-family:'Geist Mono Variable',monospace;font-size:11px;letter-spacing:0.02em;"><b style="color:#00D4FF">${cs}</b><div style="color:#A0AEC0;margin-top:2px">click to brief</div></div>`).addTo(map)
      })
      map.on('mouseleave', 'flight-points', () => {
        map.getCanvas().style.cursor = ''
        popup.remove()
      })
    })
    return () => {
      setMapInstance(null)
      map.remove()
      initedRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update winds layer data + visibility
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const src = map.getSource('winds') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    // We use animated streamlines now (WindStreamlines overlay). Keep the static arrow
    // layer hidden — streamlines are the primary visualization.
    if (map.getLayer('winds-arrow')) map.setLayoutProperty('winds-arrow', 'visibility', 'none')
    if (map.getLayer('winds-label')) map.setLayoutProperty('winds-label', 'visibility', 'none')
    src.setData({
      type: 'FeatureCollection',
      features: winds.map((w) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
        properties: { icao: w.icao, wind_kt: w.wind_kt, wind_dir_deg: w.wind_dir_deg, gust_kt: w.gust_kt ?? null, source: w.source ?? 'metar' },
      })),
    })
  }, [winds, layers.winds])

  // Theme-react: recolor the static map layers when theme changes
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    map.setPaintProperty('bg-fill', 'background-color', THEME_MAP_BG[theme])
    if (map.getLayer('flight-points')) map.setPaintProperty('flight-points', 'circle-color', THEME_FLIGHTS_DOT[theme])
    if (map.getLayer('routes-line')) map.setPaintProperty('routes-line', 'line-color', THEME_ROUTES_FAINT[theme])
    if (map.getLayer('active-line')) map.setPaintProperty('active-line', 'line-color', THEME_ACTIVE_LINE[theme])
    if (map.getLayer('gc-line')) map.setPaintProperty('gc-line', 'line-color', THEME_GC_LINE[theme])
    if (map.getLayer('active-label')) map.setPaintProperty('active-label', 'text-halo-color', THEME_ACTIVE_LABEL_HALO[theme])
    if (map.getLayer('active-heading')) map.setPaintProperty('active-heading', 'text-halo-color', THEME_ACTIVE_LABEL_HALO[theme])
    if (map.getLayer('active-core')) map.setPaintProperty('active-core', 'circle-stroke-color', THEME_ACTIVE_LABEL_HALO[theme])
  }, [theme])

  // Update weather raster
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const src = map.getSource('wx') as maplibregl.ImageSource | undefined
    if (!src) return
    if (!weather || !layers.weather) {
      // hide
      if (map.getLayer('wx-layer')) map.setPaintProperty('wx-layer', 'raster-opacity', 0)
      return
    }
    if (map.getLayer('wx-layer')) map.setPaintProperty('wx-layer', 'raster-opacity', 0.7)
    const url = gridToDataURL(weather.values, weather.rows, weather.cols)
    src.updateImage({
      url,
      coordinates: [
        [weather.bbox.lon_min, weather.bbox.lat_max],
        [weather.bbox.lon_max, weather.bbox.lat_max],
        [weather.bbox.lon_max, weather.bbox.lat_min],
        [weather.bbox.lon_min, weather.bbox.lat_min],
      ],
    })
  }, [weather, layers.weather])

  // Update sectors
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const src = map.getSource('sectors') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const visible = layers.sectors
    map.setLayoutProperty('sectors-fill', 'visibility', visible ? 'visible' : 'none')
    map.setLayoutProperty('sectors-line', 'visibility', visible ? 'visible' : 'none')
    if (map.getLayer('sectors-label')) map.setLayoutProperty('sectors-label', 'visibility', visible ? 'visible' : 'none')
    // Only show HIGH band by default to reduce clutter
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: sectors.filter((s) => s.properties.name.startsWith('HIGH_')) as unknown as GeoJSON.Feature[],
    }
    src.setData(fc)
  }, [sectors, layers.sectors])

  // Routes (faint backdrop)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const src = map.getSource('routes') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const visible = layers.flights
    map.setLayoutProperty('routes-line', 'visibility', visible ? 'visible' : 'none')
    map.setLayoutProperty('flight-points', 'visibility', visible ? 'visible' : 'none')
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: flights.map((f) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: f.lats.map((la, i) => [f.lons[i], la]) },
        properties: { id: f.id, callsign: f.callsign },
      })),
    }
    src.setData(fc)
  }, [flights, layers.flights])

  // Flight positions at current time
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded() || !currentTime) return
    const t = new Date(currentTime).getTime()
    // Heading is already computed for every flight inside positionFor (used by the
    // active-plane icon). The same heading rotates dim planes for non-active flights.
    const positionFor = (f: typeof flights[number]): GeoJSON.Feature | null => {
      const t0 = new Date(f.take_off_time).getTime()
      const t1 = new Date(f.scheduled_landing_time).getTime()
      if (t < t0 || t > t1) return null
      const frac = (t - t0) / (t1 - t0)
      const lats = f.lats
      const lons = f.lons
      const cum = [0]
      for (let i = 1; i < lats.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(lats[i] - lats[i - 1], (lons[i] - lons[i - 1]) * Math.cos((lats[i] * Math.PI) / 180)))
      }
      const total = cum[cum.length - 1] || 1
      const target = frac * total
      let idx = cum.findIndex((c) => c >= target)
      if (idx <= 0) idx = 1
      idx = Math.min(idx, lats.length - 1)
      const seg = cum[idx] - cum[idx - 1] || 1
      const sf = (target - cum[idx - 1]) / seg
      const lat = lats[idx - 1] + sf * (lats[idx] - lats[idx - 1])
      const lon = lons[idx - 1] + sf * (lons[idx] - lons[idx - 1])
      // heading bearing from current position toward the next waypoint (or destination if last)
      const tgtIdx = Math.min(idx, lats.length - 1)
      const dLat = lats[tgtIdx] - lat
      const dLon = (lons[tgtIdx] - lon) * Math.cos((lat * Math.PI) / 180)
      const heading = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [lon, lat] },
        properties: { id: f.id, callsign: f.callsign, heading },
      }
    }
    const others: GeoJSON.Feature[] = []
    let active: GeoJSON.Feature | null = null
    for (const f of flights) {
      const p = positionFor(f)
      if (!p) continue
      if (f.id === activeFlightId) active = p
      else others.push(p)
    }
    const src = map.getSource('flight-positions') as maplibregl.GeoJSONSource | undefined
    if (src) src.setData({ type: 'FeatureCollection', features: others })
    const activeSrc = map.getSource('active-position') as maplibregl.GeoJSONSource | undefined
    if (activeSrc) activeSrc.setData({ type: 'FeatureCollection', features: active ? [active] : [] })
  }, [flights, currentTime, activeFlightId])

  // Active flight + advisory routes
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const active = flights.find((f) => f.id === activeFlightId)
    const activeSrc = map.getSource('active-route') as maplibregl.GeoJSONSource | undefined
    const behindSrc = map.getSource('active-route-behind') as maplibregl.GeoJSONSource | undefined
    if (active && activeSrc && behindSrc && currentTime) {
      // Split the filed waypoints at the position corresponding to currentTime
      const t = new Date(currentTime).getTime()
      const t0 = new Date(active.take_off_time).getTime()
      const t1 = new Date(active.scheduled_landing_time).getTime()
      const lats = active.lats
      const lons = active.lons
      const cum = [0]
      for (let i = 1; i < lats.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(lats[i] - lats[i - 1], (lons[i] - lons[i - 1]) * Math.cos((lats[i] * Math.PI) / 180)))
      }
      const total = cum[cum.length - 1] || 1
      const frac = Math.max(0, Math.min(1, (t - t0) / Math.max(t1 - t0, 1)))
      const target = frac * total
      let idx = cum.findIndex((c) => c >= target)
      if (idx <= 0) idx = 1
      idx = Math.min(idx, lats.length - 1)
      const seg = cum[idx] - cum[idx - 1] || 1
      const sf = (target - cum[idx - 1]) / seg
      const splitLat = lats[idx - 1] + sf * (lats[idx] - lats[idx - 1])
      const splitLon = lons[idx - 1] + sf * (lons[idx] - lons[idx - 1])
      const behindCoords: [number, number][] = []
      for (let i = 0; i <= idx - 1; i++) behindCoords.push([lons[i], lats[i]])
      behindCoords.push([splitLon, splitLat])
      const aheadCoords: [number, number][] = [[splitLon, splitLat]]
      for (let i = idx; i < lats.length; i++) aheadCoords.push([lons[i], lats[i]])
      activeSrc.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: aheadCoords }, properties: { id: active.id, phase: 'ahead' } }],
      })
      behindSrc.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: behindCoords }, properties: { id: active.id, phase: 'behind' } }],
      })
    } else if (activeSrc && behindSrc) {
      activeSrc.setData({ type: 'FeatureCollection', features: [] })
      behindSrc.setData({ type: 'FeatureCollection', features: [] })
    }
    // Great-circle baseline (from origin to destination of the active flight)
    const gcSrc = map.getSource('gc-route') as maplibregl.GeoJSONSource | undefined
    if (gcSrc) {
      gcSrc.setData({
        type: 'FeatureCollection',
        features: active ? [{
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: greatCirclePoints(
              active.lats[0], active.lons[0],
              active.lats[active.lats.length - 1], active.lons[active.lons.length - 1],
              48,
            ),
          },
          properties: { id: `${active.id}-gc` },
        }] : [],
      })
    }
    // options — color via shared optionColor()
    const optSrc = map.getSource('options') as maplibregl.GeoJSONSource | undefined
    if (optSrc) {
      const opts = advisory?.options ?? []
      optSrc.setData({
        type: 'FeatureCollection',
        features: opts.map((o) => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: o.lats.map((la, j) => [o.lons[j], la]) },
          properties: { id: o.id, color: optionColor(o, opts) },
        })),
      })
    }
    const rejSrc = map.getSource('rejected') as maplibregl.GeoJSONSource | undefined
    if (rejSrc) {
      rejSrc.setData({
        type: 'FeatureCollection',
        features: (advisory?.rejected ?? [])
          // rejected has no geometry; skip
          .filter((r) => 'lats' in r && 'lons' in r)
          .map((r) => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: ((r as unknown) as { lats: number[]; lons: number[] }).lats.map((la: number, j: number) => [((r as unknown) as { lats: number[]; lons: number[] }).lons[j], la]) },
            properties: { id: r.id, reason: r.reason },
          })),
      })
    }
    // crowd routes (filed + great circle of nearby flights)
    const crowdFiledSrc = map.getSource('crowd-filed') as maplibregl.GeoJSONSource | undefined
    const crowdGcSrc = map.getSource('crowd-gc') as maplibregl.GeoJSONSource | undefined
    const showCrowd = showCrowdRoutes && advisory != null
    if (map.getLayer('crowd-filed-line')) map.setLayoutProperty('crowd-filed-line', 'visibility', showCrowd ? 'visible' : 'none')
    if (map.getLayer('crowd-gc-line')) map.setLayoutProperty('crowd-gc-line', 'visibility', showCrowd ? 'visible' : 'none')
    if (crowdFiledSrc) {
      crowdFiledSrc.setData({
        type: 'FeatureCollection',
        features: (advisory?.crowd_signal.examples ?? [])
          .filter((ex) => ex.filed_lats && ex.filed_lons)
          .map((ex) => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: ex.filed_lats!.map((la, j) => [ex.filed_lons![j], la]) },
            properties: { flight: ex.flight, is_detour: ex.is_detour },
          })),
      })
    }
    if (crowdGcSrc) {
      crowdGcSrc.setData({
        type: 'FeatureCollection',
        features: (advisory?.crowd_signal.examples ?? [])
          .filter((ex) => ex.gc_lats && ex.gc_lons)
          .map((ex) => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: ex.gc_lats!.map((la, j) => [ex.gc_lons![j], la]) },
            properties: { flight: ex.flight },
          })),
      })
    }

    // hovered option emphasis
    if (map.getLayer('options-line')) {
      map.setPaintProperty('options-line', 'line-width', [
        'case',
        ['==', ['get', 'id'], hoveredOption ?? ''], 3.4,
        2,
      ])
    }
  }, [activeFlightId, advisory, flights, hoveredOption, showCrowdRoutes, currentTime])

  // Only fit map to the active flight when the flight selection actually changes.
  // Hover/advisory updates must not re-zoom or the UI feels broken.
  const lastZoomedFlightRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const map = mapRef.current
    if (!map || !activeFlightId) return
    if (lastZoomedFlightRef.current === activeFlightId) return
    const active = flights.find((f) => f.id === activeFlightId)
    if (!active) return
    const lats = active.lats
    const lons = active.lons
    const bbox: [number, number, number, number] = [
      Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats),
    ]
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
      padding: { top: 80, right: 460, bottom: 160, left: 360 },
      duration: 800,
    })
    lastZoomedFlightRef.current = activeFlightId
  }, [activeFlightId, flights])

  return <div ref={ref} className="absolute inset-0" />
}
