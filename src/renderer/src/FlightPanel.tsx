import type { LiveSim } from '../../shared/airframe'
import type { DescentSettings, Journey, Leg, ReachOptions } from '../../shared/journey'
import { AirportCard, checkpointName, course, NavLogTable, TerrainProfile, useLegBrief } from './Briefing'
import { clock, descentAhead, nextCheckpoint, routeProgress } from './flightProgress'
import { feet } from './legNotes'
import { DescentSwitch, LegHeading, legEyebrow, ReachCard } from './LegParts'
import { currentSegment, VorRouteList } from './VorRouteList'

/** Refreshed now and then for the wind at the aircraft; the route itself doesn't change in flight. */
const BRIEF_REFRESH_MS = 120_000
/** Further off the planned line than this is worth saying. */
const OFF_ROUTE_NM = 3

function Readout({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="readout">
      <span className="readout-label">{label}</span>
      <span className="readout-value">
        {value}
        {unit && <small> {unit}</small>}
      </span>
    </div>
  )
}

/** In the air with no Journey leg to follow: just where the aircraft is. */
function FreeFlight({ live }: { live: LiveSim }) {
  return (
    <article className="card flight-card">
      <p className="eyebrow">In flight · not on a Journey leg</p>
      <h2>{live.nearAirport ? `Near ${live.nearAirport.ident}` : 'In the air'}</h2>
      <div className="readouts">
        <Readout label="Altitude" value={live.altFt == null ? '—' : Math.round(live.altFt).toLocaleString()} unit="ft" />
        <Readout label="Groundspeed" value={live.gsKts == null ? '—' : String(Math.round(live.gsKts))} unit="kt" />
        <Readout label="Heading" value={live.headingTrue == null ? '—' : course(Math.round(live.headingTrue) % 360 || 360)} unit="true" />
      </div>
      <p className="muted">The flight is being logged. Plan a Journey to get a leg, checkpoints and arrival here.</p>
    </article>
  )
}

/**
 * Everything worth a glance while flying a leg, and nothing else: how far and how long to go, the next
 * checkpoint, the radio stretch being flown, top of descent, fuel and the arrival.
 */
export function FlightPanel({
  journey,
  leg,
  live,
  reach,
  descent,
  onDescentChange,
  onAcceptReach
}: {
  journey: Journey | null
  leg: Leg | null
  live: LiveSim
  reach: ReachOptions | null
  descent: DescentSettings | null
  onDescentChange: (on: boolean) => void
  onAcceptReach: (ident: string) => void
}) {
  if (!journey || !leg || live.lat === null || live.lon === null) return <FreeFlight live={live} />
  return <LegInFlight journey={journey} leg={leg} live={live} reach={reach} descent={descent} onDescentChange={onDescentChange} onAcceptReach={onAcceptReach} />
}

function LegInFlight({
  journey,
  leg,
  live,
  reach,
  descent,
  onDescentChange,
  onAcceptReach
}: {
  journey: Journey
  leg: Leg
  live: LiveSim
  reach: ReachOptions | null
  descent: DescentSettings | null
  onDescentChange: (on: boolean) => void
  onAcceptReach: (ident: string) => void
}) {
  const { brief } = useLegBrief(journey.id, leg, journey.limits, true, BRIEF_REFRESH_MS)
  const position = { lat: live.lat!, lon: live.lon! }
  const progress = routeProgress(leg, position)
  const gs = live.gsKts ?? 0
  const eteMinutes = gs > 30 ? (progress.toGoNm / gs) * 60 : null
  const next = brief ? nextCheckpoint(brief.navLog, progress.alongNm) : null
  const after = brief && next ? brief.navLog[next.index + 1] : undefined
  const arrivalElevation = brief?.arrival?.elevationFt ?? null
  const tod = descent && live.altFt != null && arrivalElevation !== null ? descentAhead(live.altFt, live.gsKts, progress.toGoNm, arrivalElevation, descent) : null
  const segment = leg.vorRoute?.length ? currentSegment(leg, progress.alongNm) : null

  return (
    <article className="card flight-card">
      <LegHeading leg={leg} eyebrow={`In flight · ${legEyebrow(journey, leg)}`} />

      <div className="readouts">
        <Readout label={`To ${leg.to.ident}`} value={String(Math.round(progress.toGoNm))} unit="nm" />
        <Readout label="Time to go" value={eteMinutes === null ? '—' : clock(eteMinutes)} unit={eteMinutes === null ? undefined : `at ${Math.round(gs)} kt`} />
        <Readout label="Altitude" value={live.altFt == null ? '—' : Math.round(live.altFt).toLocaleString()} unit="ft" />
        {brief && <Readout label="Suggested cruise" value={brief.cruise.suggestedFt.toLocaleString()} unit="ft" />}
      </div>
      {progress.offRouteNm > OFF_ROUTE_NM && <p className="note">About {Math.round(progress.offRouteNm)} nm off the planned route.</p>}
      {live.paused && <p className="muted">The sim is paused.</p>}

      {next && (
        <section className="next-checkpoint" aria-label="Next checkpoint">
          <h4>Next checkpoint</h4>
          <p className="next-checkpoint-name">{checkpointName(next.row)}</p>
          <p>
            <strong>{Math.round(next.inNm)} nm</strong>
            {gs > 30 && <> · {clock((next.inNm / gs) * 60)}</>} · course {course(next.row.courseDeg)}
            {next.row.headingDeg !== null && <> · heading {course(next.row.headingDeg)} for the wind</>}
          </p>
          {after && <p className="muted">Then {checkpointName(after)}, {Math.round(after.legNm)} nm further.</p>}
        </section>
      )}

      {segment !== null && (
        <section aria-label="Radio route">
          <h4>Radio route</h4>
          <VorRouteList leg={leg} currentIndex={segment} />
        </section>
      )}

      {tod && descent && (
        <section aria-label="Top of descent">
          <h4>Top of descent</h4>
          <p>
            {live.altFt! <= tod.levelOffFt + 200
              ? `No descent to plan: you're at or below the ${feet(tod.levelOffFt)} level-off height for ${leg.to.ident}.`
              : tod.toTodNm <= 0
                ? `Time to start down to ${feet(tod.levelOffFt)}.`
                : `In about ${Math.round(tod.toTodNm)} nm${tod.minutes !== null ? ` (${clock(tod.minutes)})` : ''}, down to ${feet(tod.levelOffFt)} at ${descent.angleDeg}°.`}
          </p>
          <DescentSwitch to={leg.to.ident} descent={descent} onChange={onDescentChange} />
        </section>
      )}

      {reach?.journeyId === journey.id && (
        <section aria-label="Fuel">
          <h4>Fuel</h4>
          <ReachCard reach={reach} onAccept={onAcceptReach} />
        </section>
      )}

      {brief?.arrival && <AirportCard card={brief.arrival} role="Arrival" />}

      {brief && (
        <details className="kneeboard">
          <summary>Full nav log and terrain</summary>
          <TerrainProfile
            profile={brief.profile}
            totalNm={brief.totalNm}
            cruiseFt={brief.cruise.suggestedFt}
            ceilingFt={journey.limits.maxAltitudeFt}
            aircraft={live.altFt == null ? null : { alongNm: progress.alongNm, altFt: live.altFt }}
          />
          <NavLogTable rows={brief.navLog} nextIndex={next?.index ?? brief.navLog.length} />
        </details>
      )}
    </article>
  )
}
