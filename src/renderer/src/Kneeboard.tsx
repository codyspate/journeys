import { useState } from 'react'
import type { Leg, RouteEdit, RouteLimits } from '../../shared/journey'
import { AirportCard, CruiseLine, NAV_LOG_NOTE, NavLogTable, TerrainProfile, useLegBrief, WindLine } from './Briefing'
import { VorRouteList } from './VorRouteList'

/** A planned leg's briefing, folded away until opened, wherever the leg is listed. Suggestions only. */
/** Add a station by its ident, or go back to the suggested route. Changes are kept for this leg whenever it's planned. */
function RadioRouteEditor({ leg, onEdit }: { leg: Leg; onEdit: (edit: RouteEdit) => void }) {
  const [ident, setIdent] = useState('')
  const pair = { from: leg.from.ident, to: leg.to.ident }
  return (
    <div className="radio-route-editor">
      <form
        className="fields"
        onSubmit={(e) => {
          e.preventDefault()
          if (!ident.trim()) return
          onEdit({ kind: 'radio-add', ...pair, ident })
          setIdent('')
        }}
      >
        <label className="field small">
          <span>Add a station by its ident</span>
          <input value={ident} placeholder="Such as TMN" onChange={(e) => setIdent(e.target.value.toUpperCase())} />
        </label>
        <button type="submit" className="secondary" disabled={!ident.trim()}>
          Add
        </button>
      </form>
      {leg.vorRouteChosen ? (
        <p className="muted">
          Your own route for this leg.{' '}
          <button className="link" onClick={() => onEdit({ kind: 'radio-reset', ...pair })}>
            Use the suggested route
          </button>
        </p>
      ) : (
        <p className="muted">Skip a station to fly past it, or add one, and Journeys keeps your route for this leg.</p>
      )}
    </div>
  )
}

export function Kneeboard({
  journeyId,
  leg,
  limits,
  open = false,
  onEdit
}: {
  journeyId: string
  leg: Leg
  limits: RouteLimits
  open?: boolean
  /** Lets the radio route be changed here, in the planner. */
  onEdit?: (edit: RouteEdit) => void
}) {
  const [shown, setShown] = useState(open)
  const pair = { from: leg.from.ident, to: leg.to.ident }
  const { brief, error } = useLegBrief(journeyId, leg, limits, shown)

  return (
    <details className="kneeboard" open={shown} onToggle={(e) => setShown((e.target as HTMLDetailsElement).open)}>
      <summary>{leg.vorRoute?.length ? 'Briefing: radio route, cruise, checkpoints, airports' : 'Briefing: cruise, checkpoints, airports'}</summary>
      {shown && <VorRouteList leg={leg} onSkip={onEdit && ((index) => onEdit({ kind: 'radio-skip', ...pair, index }))} />}
      {shown && onEdit && limits.vorRoutes && <RadioRouteEditor leg={leg} onEdit={onEdit} />}
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
