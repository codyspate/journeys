import type { Leg, Stop, VorFix } from './journey'

const EARTH_NM = 3440.065
const toRad = Math.PI / 180

type Point = Pick<Stop, 'lat' | 'lon'>

function distanceNm(a: Point, b: Point): number {
  const dLat = (b.lat - a.lat) * toRad
  const dLon = (b.lon - a.lon) * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** True bearing setting off from a towards b, 0 to 360. */
function initialBearing(a: Point, b: Point): number {
  const dLon = (b.lon - a.lon) * toRad
  const y = Math.sin(dLon) * Math.cos(b.lat * toRad)
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLon)
  return (Math.atan2(y, x) / toRad + 360) % 360
}

/** True bearing arriving at b from a. On a long great circle it differs from the bearing setting off. */
const finalBearing = (a: Point, b: Point) => (initialBearing(b, a) + 180) % 360

/** Magnetic = true − variation (east positive), as a whole degree from 1 to 360, the way it's flown. */
export function magnetic(trueDeg: number, variationDeg: number): number {
  const deg = Math.round((((trueDeg - variationDeg) % 360) + 360) % 360)
  return deg === 0 ? 360 : deg
}

export const formatCourse = (deg: number) => `${String(deg).padStart(3, '0')}°`

export interface RouteSegment {
  from: Stop | VorFix
  to: Stop | VorFix
  /** Set when the stretch starts at a VOR: the radial to track out on, measured at that station. */
  outboundRadial: number | null
  /** Set when the stretch ends at a VOR: the course to track in on, measured at that station. */
  inboundCourse: number | null
  distanceNm: number
}

export const isVor = (point: Stop | VorFix): point is VorFix => 'freqMhz' in point

/** Each stretch of a leg's radio route, with what to set on the OBS for it. */
export function routeSegments(leg: Pick<Leg, 'from' | 'to' | 'vorRoute'>): RouteSegment[] {
  if (!leg.vorRoute || leg.vorRoute.length === 0) return []
  const points: (Stop | VorFix)[] = [leg.from, ...leg.vorRoute, leg.to]
  const segments = points.slice(1).map((to, i) => {
    const from = points[i]
    return {
      from,
      to,
      outboundRadial: isVor(from) ? magnetic(initialBearing(from, to), from.magVarDeg ?? 0) : null,
      inboundCourse: isVor(to) ? magnetic(finalBearing(from, to), to.magVarDeg ?? 0) : null,
      distanceNm: distanceNm(from, to)
    }
  })
  // A VOR on the airport itself leaves a stretch of almost nothing to fly; it isn't worth a line.
  return segments.filter((segment, i) => segment.distanceNm >= ON_FIELD_NM || (i !== 0 && i !== segments.length - 1))
}

const ON_FIELD_NM = 1
