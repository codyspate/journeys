import type { Leg, Stop, VorFix } from '../../shared/journey'
import { formatCourse, isVor, routeSegments } from '../../shared/vorCourse'

const label = (point: Stop | VorFix) => (isVor(point) ? `${point.ident} ${point.freqMhz.toFixed(2)}` : point.ident)

/** A leg's radio route as stretches to fly: what to set for each, and how far. */
export function VorRouteList({ leg }: { leg: Leg }) {
  const segments = routeSegments(leg)
  if (segments.length === 0) return null
  return (
    <div className="vor-route">
      <ol aria-label={`VOR route from ${leg.from.ident} to ${leg.to.ident}`}>
        {segments.map((segment, i) => (
          <li key={i}>
            <span className="vor-route-points">
              {label(segment.from)} → {label(segment.to)}
            </span>
            <span>
              {segment.outboundRadial !== null && `out on R-${formatCourse(segment.outboundRadial).slice(0, 3)}`}
              {segment.outboundRadial !== null && segment.inboundCourse !== null && ', '}
              {segment.inboundCourse !== null && `in on ${formatCourse(segment.inboundCourse)}`}
            </span>
            <span className="vor-route-nm">{Math.round(segment.distanceNm)} nm</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
