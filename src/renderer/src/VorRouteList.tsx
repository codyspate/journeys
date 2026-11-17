import type { Leg, Stop, VorFix } from '../../shared/journey'
import { formatCourse, frequencyLabel, isNdbFix, isVor, type RouteSegment, routeSegments } from '../../shared/vorCourse'

/** Shorter gaps out of reception are just the edge of a station's range, not worth a mention. */
const MENTION_GAP_NM = 5

export const pointLabel = (point: Stop | VorFix) => (isVor(point) ? `${point.ident} ${frequencyLabel(point)}` : point.ident)

/** What to track: a radial out of a VOR, a bearing out of an NDB, and the course in to the next. */
export function guidance(segment: RouteSegment): string {
  const parts: string[] = []
  if (segment.outboundRadial !== null && isVor(segment.from)) {
    const deg = formatCourse(segment.outboundRadial)
    parts.push(isNdbFix(segment.from) ? `out on ${deg}` : `out on R-${deg.slice(0, 3)}`)
  }
  if (segment.inboundCourse !== null) parts.push(`in on ${formatCourse(segment.inboundCourse)}`)
  return parts.join(', ')
}

/** Which stretch the aircraft is on, from how far along the route it is. */
export function currentSegment(leg: Pick<Leg, 'from' | 'to' | 'vorRoute'>, alongNm: number): number {
  const segments = routeSegments(leg)
  let end = 0
  for (let i = 0; i < segments.length; i++) {
    end += segments[i].distanceNm
    if (alongNm < end) return i
  }
  return segments.length - 1
}

/**
 * A leg's radio route as stretches to fly: what to set for each, and how far. In flight, `currentIndex`
 * marks the stretch being flown and fades the ones already done.
 */
export function VorRouteList({ leg, currentIndex = null }: { leg: Leg; currentIndex?: number | null }) {
  const segments = routeSegments(leg)
  if (segments.length === 0) return null
  const state = (i: number) => (currentIndex === null ? undefined : i < currentIndex ? 'passed' : i === currentIndex ? 'current' : undefined)
  return (
    <div className="vor-route">
      <ol aria-label={`Radio route from ${leg.from.ident} to ${leg.to.ident}`}>
        {segments.map((segment, i) => (
          <li key={i} className={state(i)} aria-current={i === currentIndex ? 'step' : undefined}>
            <span className="vor-route-points">
              {pointLabel(segment.from)} → {pointLabel(segment.to)}
            </span>
            <span>
              {guidance(segment)}
              {segment.gapNm >= MENTION_GAP_NM && <span className="muted"> · about {Math.round(segment.gapNm)} nm on heading between stations</span>}
            </span>
            <span className="vor-route-nm">{Math.round(segment.distanceNm)} nm</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
