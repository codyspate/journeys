import { useEffect, useState } from 'react'
import type { Journey } from '../../shared/journey'
import type { JourneySummary } from '../../shared/summary'
import { hoursMinutes } from './homeState'

const countryNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' })
  } catch {
    return null
  }
})()
const countryName = (code: string) => {
  try {
    return countryNames?.of(code) ?? code
  } catch {
    return code
  }
}

const dateRange = (from: number, to: number) => {
  const a = new Date(from).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const b = new Date(to).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return a === b ? a : `${a} – ${b}`
}

export function useJourneySummary(journey: Journey | null): JourneySummary | null {
  const [summary, setSummary] = useState<JourneySummary | null>(null)
  const id = journey?.status === 'complete' ? journey.id : null
  const flownCount = journey?.legs.length ?? 0
  useEffect(() => {
    setSummary(null)
    if (!id) return
    let current = true
    void window.journeys.journeySummary(id).then((found) => current && setSummary(found))
    return () => {
      current = false
    }
  }, [id, flownCount])
  return summary
}

/** The look back over a finished Journey: a title, the big numbers, the highlights and a few fun facts. */
export function JourneySummaryCard({
  journey,
  summary,
  onOpen
}: {
  journey: Journey
  summary: JourneySummary
  /** Given on Home: shows the short form, with a way to the whole summary. */
  onOpen?: () => void
}) {
  const s = summary
  const compact = Boolean(onOpen)
  return (
    <article className="card journey-summary" aria-label={`Summary of ${journey.name}`}>
      <p className="eyebrow">
        Journey complete
        {s.startedAt !== null && s.finishedAt !== null && ` · ${dateRange(s.startedAt, s.finishedAt)}`}
      </p>
      <h2>
        {journey.origin.ident} → {journey.destination.ident}
      </h2>
      <p className="summary-title">{s.title}</p>

      <div className="summary-numbers">
        <Big value={s.distanceNm.toLocaleString()} unit="nm flown" />
        <Big value={String(s.legs)} unit={s.legs === 1 ? 'leg' : 'legs'} />
        <Big value={hoursMinutes(s.airMinutes)} unit="in the air" />
        <Big value={s.fuelGal.toLocaleString()} unit="gal burned" />
        <Big value={String(s.airports)} unit="airports" />
        {s.countries.length > 0 && <Big value={String(s.countries.length)} unit={s.countries.length === 1 ? 'country' : 'countries'} />}
      </div>

      {s.funFacts.length > 0 && (
        <ul className="summary-facts">
          {(compact ? s.funFacts.slice(0, 2) : s.funFacts).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}

      {compact && (
        <div className="card-actions">
          <button className="secondary" onClick={onOpen}>
            See the whole summary
          </button>
        </div>
      )}

      {!compact && <h4>Highlights</h4>}
      {!compact && <dl className="summary-highlights">
        {s.softest && <Highlight label="Softest landing" value={`${s.softest.touchdownFpm} fpm at ${s.softest.ident}`} />}
        {s.firmest && <Highlight label="Firmest landing" value={`${s.firmest.touchdownFpm} fpm at ${s.firmest.ident}`} />}
        {s.longestLeg && <Highlight label="Longest leg" value={`${s.longestLeg.from} → ${s.longestLeg.to}, ${s.longestLeg.distanceNm} nm`} />}
        {s.shortestLeg && <Highlight label="Shortest hop" value={`${s.shortestLeg.from} → ${s.shortestLeg.to}, ${s.shortestLeg.distanceNm} nm`} />}
        {s.highestFt !== null && <Highlight label="Highest" value={`${s.highestFt.toLocaleString()} ft`} />}
        {s.maxG !== null && <Highlight label="Most g" value={`${s.maxG.toFixed(2)} g`} />}
        {s.countries.length > 1 && <Highlight label="Countries" value={s.countries.map(countryName).join(', ')} />}
        {s.aircraft.length > 0 && <Highlight label={s.aircraft.length === 1 ? 'Aircraft' : 'Aircraft flown'} value={s.aircraft.join(', ')} />}
        {(s.photos > 0 || s.notes > 0) && (
          <Highlight
            label="Memories"
            value={[s.photos > 0 && `${s.photos} ${s.photos === 1 ? 'photo' : 'photos'}`, s.notes > 0 && `${s.notes} ${s.notes === 1 ? 'note' : 'notes'}`].filter(Boolean).join(', ')}
          />
        )}
        {s.stallWarnings > 0 && <Highlight label="Stall horns" value={`${s.stallWarnings}. We won't tell anyone.`} />}
      </dl>}
    </article>
  )
}

function Big({ value, unit }: { value: string; unit: string }) {
  return (
    <span>
      <strong>{value}</strong>
      <span className="muted">{unit}</span>
    </span>
  )
}

function Highlight({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}
