import { useEffect, useState } from 'react'
import type { DescentSettings, Journey, Leg, ReachOptions } from '../../shared/journey'
import { hoursMinutes } from './homeState'
import { feet, MENTION_WATER_NM } from './legNotes'

/** Pieces every leg is shown with, so a leg reads the same on Home, in the flight view and in the planner. */

/** "Journey name · leg 2 of 6", the line above a leg's heading. */
export function legEyebrow(journey: Journey, leg: Leg): string {
  const number = journey.legs.findIndex((l) => l.id === leg.id) + 1
  return `${journey.name} · leg ${number} of ${journey.legs.length}`
}

export function LegHeading({ leg, eyebrow }: { leg: Leg; eyebrow: string }) {
  return (
    <>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="leg-route">
        {leg.from.ident} <span aria-hidden="true">→</span>
        <span className="sr-only">to</span> {leg.to.ident}
      </h2>
      <p className="muted">
        {leg.from.name} to {leg.to.name}
      </p>
    </>
  )
}

/** Distance, time, fuel and terrain for a leg, as planned. */
export function LegStats({ leg, large = false }: { leg: Leg; large?: boolean }) {
  return (
    <div className={large ? 'leg-stats large' : 'leg-stats'}>
      <span>
        <strong>{Math.round(leg.distanceNm)}</strong> nm
      </span>
      <span>
        <strong>{hoursMinutes(leg.minutes)}</strong> at cruise
      </span>
      <span>
        <strong>{leg.fuelGal.toFixed(0)}</strong> gal
      </span>
      {leg.highestTerrainFt != null && (
        <span>
          highest ground <strong>{feet(leg.highestTerrainFt)}</strong>
        </span>
      )}
      {leg.longestWaterNm != null && leg.longestWaterNm >= MENTION_WATER_NM && (
        <span>
          <strong>{Math.round(leg.longestWaterNm)}</strong> nm over water
        </span>
      )}
    </div>
  )
}

/** The app-wide top-of-descent pause, as a switch. Remembered across restarts. */
export function useDescentSettings() {
  const [descent, setDescent] = useState<DescentSettings | null>(null)
  useEffect(() => {
    void window.journeys.getSettings().then((settings) => setDescent(settings.descent ?? null))
  }, [])
  const setPause = async (on: boolean) => {
    if (!descent) return
    const settings = await window.journeys.updateSettings({ descent: { ...descent, pauseBeforeTod: on } })
    setDescent(settings.descent)
  }
  return { descent, setPause }
}

export function DescentSwitch({ to, descent, onChange }: { to: string; descent: DescentSettings; onChange: (on: boolean) => void }) {
  return (
    <label className="checkbox descent-toggle">
      <input type="checkbox" checked={descent.pauseBeforeTod} onChange={(e) => onChange(e.target.checked)} />
      Pause the sim {descent.minutesBefore} min before top of descent into {to}
    </label>
  )
}

/** What the fuel on board and groundspeed now allow, compared with the plan. Only ever offers. */
export function ReachCard({ reach, onAccept }: { reach: ReachOptions; onAccept: (ident: string) => void }) {
  const choice = reach.further ?? reach.closer
  return (
    <div className={reach.canReachPlanned ? 'reach' : 'reach short'} role="status">
      <p>
        {reach.plannedStop.ident} is {Math.round(reach.distanceToPlannedNm)} nm away, arriving with{' '}
        <strong>{Math.max(0, Math.round(reach.reserveAtPlannedMinutes))} min</strong> of fuel
        {reach.canReachPlanned ? '.' : ', less than your reserve.'}
      </p>
      {choice && (
        <p>
          <strong>{choice.stop.name}</strong> ({choice.stop.ident}) is {reach.further ? 'also in reach' : 'an option'},{' '}
          {Math.round(choice.distanceNm)} nm away with {Math.max(0, Math.round(choice.reserveMinutes))} min of fuel.{' '}
          <button className="link" onClick={() => onAccept(choice.stop.ident)}>
            Make it my next stop
          </button>
        </p>
      )}
    </div>
  )
}
