import type { DescentSettings, Journey, Leg } from '../../shared/journey'
import { AirportCard, CruiseLine, NAV_LOG_NOTE, NavLogTable, TerrainProfile, useLegBrief, WindLine } from './Briefing'
import { legNotes } from './legNotes'
import { DescentSwitch, LegHeading, legEyebrow, LegStats } from './LegParts'
import { VorRouteList } from './VorRouteList'

/** The wind at the aircraft changes while sitting on the ground, so the briefing refreshes now and then. */
const BRIEF_REFRESH_MS = 60_000

/**
 * The briefing for the leg about to be flown, in the order it's used: departure runway, cruise and route,
 * checkpoints, terrain, the arrival, and the descent pause.
 */
export function PreflightPanel({
  journey,
  leg,
  aircraftName,
  descent,
  onDescentChange,
  onOpenJourney
}: {
  journey: Journey
  leg: Leg
  aircraftName: string | null
  descent: DescentSettings | null
  onDescentChange: (on: boolean) => void
  onOpenJourney: () => void
}) {
  const { brief, error } = useLegBrief(journey.id, leg, journey.limits, true, BRIEF_REFRESH_MS)

  return (
    <article className="card preflight-card">
      <LegHeading leg={leg} eyebrow={`Ready to go · ${legEyebrow(journey, leg)}`} />
      <LegStats leg={leg} large />
      <p className="ready">
        You're at {leg.from.ident}
        {aircraftName ? ` in the ${aircraftName}` : ''}. Journeys starts logging as soon as you move.
      </p>
      {legNotes(leg, journey.limits).map((note) => (
        <p key={note} className="note">
          {note}
        </p>
      ))}

      {error && <p className="error">{error}</p>}
      {!brief && !error && <p className="muted">Working out the briefing…</p>}
      {brief && (
        <>
          {brief.departure && <AirportCard card={brief.departure} role="Departure" />}

          <section aria-label="Cruise and route">
            <h4>Cruise and route</h4>
            <CruiseLine cruise={brief.cruise} limits={journey.limits} />
            <VorRouteList leg={leg} />
            <TerrainProfile profile={brief.profile} totalNm={brief.totalNm} cruiseFt={brief.cruise.suggestedFt} ceilingFt={journey.limits.maxAltitudeFt} />
          </section>

          <section aria-label="Nav log">
            <h4>Nav log</h4>
            <WindLine wind={brief.wind} />
            <NavLogTable rows={brief.navLog} />
            <p className="muted settings-note">{NAV_LOG_NOTE}</p>
          </section>

          {brief.arrival && <AirportCard card={brief.arrival} role="Arrival" />}
        </>
      )}

      {descent && <DescentSwitch to={leg.to.ident} descent={descent} onChange={onDescentChange} />}
      <div className="card-actions">
        <button className="secondary" onClick={onOpenJourney}>
          Change the plan
        </button>
      </div>
    </article>
  )
}
