import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import { isRealPosition, type LandingRecord, type TrackPoint } from '../../shared/logbook'
import { unwrapLongitudes } from './mapData'

export type TrackMetric = 'altFt' | 'aglFt' | 'gsKts'

export const METRICS: { id: TrackMetric; label: string; unit: string }[] = [
  { id: 'altFt', label: 'Altitude', unit: 'ft' },
  { id: 'aglFt', label: 'Height above ground', unit: 'ft' },
  { id: 'gsKts', label: 'Groundspeed', unit: 'kt' }
]

/** One blue, dark for low values and light for high, so it reads on the dark map. Checked with the dataviz validator. */
export const RAMP = ['#256abf', '#5598e7', '#9ec5f4', '#cde2fb']
/** Enough colour stops for a smooth line without a huge style expression. */
const MAX_STOPS = 400

export interface PlottedPoint {
  t: number
  /** Sim time since the flight started, or null if unknown. */
  simSeconds: number | null
  lon: number
  lat: number
  altFt: number
  aglFt: number
  gsKts: number
  /** How far along the line this point is, 0 to 1, by distance. */
  progress: number
}

export interface FlightTrack {
  /** The whole flight as one line, so it never thins out when zoomed out. */
  line: Feature<LineString>
  points: PlottedPoint[]
  marks: FeatureCollection<Point, { kind: 'start' | 'end' | 'landing' }>
  /** Lowest and highest value of each metric, for the colour scale and legend. */
  domain: Record<TrackMetric, [number, number]>
  bounds: [[number, number], [number, number]]
}

export function buildTrack(raw: TrackPoint[], landings: LandingRecord[] = []): FlightTrack | null {
  const usable = raw.filter((p) => isRealPosition(p.lat, p.lon))
  if (usable.length < 2) return null
  const lons = unwrapLongitudes(usable.map((p) => p.lon))

  // Distance along the line on a flat projection is plenty for spreading colours.
  const along = [0]
  for (let i = 1; i < usable.length; i++) {
    const scale = Math.cos((usable[i].lat * Math.PI) / 180)
    along.push(along[i - 1] + Math.hypot((lons[i] - lons[i - 1]) * scale, usable[i].lat - usable[i - 1].lat))
  }
  const total = along.at(-1)! || 1
  const points = usable.map((p, i) => ({
    t: p.t,
    simSeconds: p.simSeconds ?? null,
    lon: lons[i],
    lat: p.lat,
    altFt: p.altFt,
    aglFt: Math.max(0, p.aglFt),
    gsKts: p.gsKts,
    progress: along[i] / total
  }))

  const domain = {} as Record<TrackMetric, [number, number]>
  for (const { id } of METRICS) {
    const values = points.map((p) => p[id])
    const low = Math.min(...values)
    const high = Math.max(...values)
    domain[id] = [low, high > low ? high : low + 1]
  }

  const nearestLon = (lat: number, lon: number) => {
    let best = points[0]
    for (const p of points) if (Math.hypot(p.lat - lat, p.lon - lon) < Math.hypot(best.lat - lat, best.lon - lon)) best = p
    return best.lon + (lon - (((best.lon + 540) % 360) - 180))
  }
  const mark = (kind: 'start' | 'end' | 'landing', lon: number, lat: number) => ({
    type: 'Feature' as const,
    properties: { kind },
    geometry: { type: 'Point' as const, coordinates: [lon, lat] }
  })

  const lats = points.map((p) => p.lat)
  return {
    line: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) } },
    points,
    marks: {
      type: 'FeatureCollection',
      features: [
        mark('start', points[0].lon, points[0].lat),
        ...landings.map((l) => mark('landing', nearestLon(l.lat, l.lon), l.lat)),
        mark('end', points.at(-1)!.lon, points.at(-1)!.lat)
      ]
    },
    domain,
    bounds: [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)]
    ]
  }
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** The ramp colour for a value, blending between neighbouring steps. */
export function rampColor(value: number, [low, high]: [number, number]): string {
  const position = Math.min(1, Math.max(0, (value - low) / (high - low))) * (RAMP.length - 1)
  const step = Math.min(RAMP.length - 2, Math.floor(position))
  const f = position - step
  const [a, b] = [channels(RAMP[step]), channels(RAMP[step + 1])]
  return `#${a.map((c, i) => Math.round(c + (b[i] - c) * f).toString(16).padStart(2, '0')).join('')}`
}

/** A MapLibre line-gradient that colours the line by the chosen measure along its length. */
export function gradientExpression(track: FlightTrack, metric: TrackMetric): unknown[] {
  const every = Math.max(1, Math.ceil(track.points.length / MAX_STOPS))
  const stops: unknown[] = []
  let last = -1
  track.points.forEach((p, i) => {
    if (i % every !== 0 && i !== track.points.length - 1) return
    // Stops must strictly increase; time spent parked adds no distance.
    if (p.progress <= last) return
    stops.push(p.progress, rampColor(p[metric], track.domain[metric]))
    last = p.progress
  })
  if (stops[0] !== 0) stops.unshift(0, rampColor(track.points[0][metric], track.domain[metric]))
  return ['interpolate', ['linear'], ['line-progress'], ...stops]
}

/** The recorded point closest to a place on the map. */
export function nearestPoint(track: FlightTrack, lon: number, lat: number): PlottedPoint {
  const scale = Math.cos((lat * Math.PI) / 180)
  let best = track.points[0]
  let bestDistance = Infinity
  for (const p of track.points) {
    const d = Math.hypot((p.lon - lon) * scale, p.lat - lat)
    if (d < bestDistance) {
      bestDistance = d
      best = p
    }
  }
  return best
}

export function formatMetric(metric: TrackMetric, value: number): string {
  const unit = METRICS.find((m) => m.id === metric)!.unit
  return `${Math.round(value).toLocaleString()} ${unit}`
}
