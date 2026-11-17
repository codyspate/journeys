import { useState } from 'react'
import type { Leg, RouteLimits } from '../../shared/journey'
import { AirportCard, CruiseLine, NAV_LOG_NOTE, NavLogTable, TerrainProfile, useLegBrief, WindLine } from './Briefing'
import { VorRouteList } from './VorRouteList'

/** A planned leg's briefing, folded away until opened, wherever the leg is listed. Suggestions only. */
export function Kneeboard({ journeyId, leg, limits, open = false }: { journeyId: string; leg: Leg; limits: RouteLimits; open?: boolean }) {
  const [shown, setShown] = useState(open)
  const { brief, error } = useLegBrief(journeyId, leg, limits, shown)

  return (
    <details className="kneeboard" open={shown} onToggle={(e) => setShown((e.target as HTMLDetailsElement).open)}>
      <summary>{leg.vorRoute?.length ? 'Briefing: radio route, cruise, checkpoints, airports' : 'Briefing: cruise, checkpoints, airports'}</summary>
      {shown && <VorRouteList leg={leg} />}
      {error && <p className="error">{error}</p>}
      {shown && !brief && !error && <p className="muted">Working it out…</p>}
      {brief && (
        <>
          <CruiseLine cruise={brief.cruise} limits={limits} />
          <TerrainProfile profile={brief.profile} totalNm={brief.totalNm} cruiseFt={brief.cruise.suggestedFt} ceilingFt={limits.maxAltitudeFt} />
          <h4>Nav log</h4>
          <WindLine wind={brief.wind} />
          <NavLogTable rows={brief.navLog} />
          <p className="muted settings-note">{NAV_LOG_NOTE}</p>
          {brief.departure && <AirportCard card={brief.departure} role="Departure" />}
          {brief.arrival && <AirportCard card={brief.arrival} role="Arrival" />}
        </>
      )}
    </details>
  )
}
