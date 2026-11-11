import { useCallback, useEffect, useState } from 'react'
import type { AirframeRecord, LiveSim } from '../../shared/airframe'
import { type Journey, type Place, PLACE_KINDS, type PlaceKind } from '../../shared/journey'
import type { LogbookFlight } from '../../shared/logbook'
import type { RestoreReport } from '../../shared/types'
import { errorText } from './errors'
import { aircraftLabels, currentJourney, hoursMinutes, progressOf, type Readiness, readiness } from './homeState'
import { AirportInput, type JourneyRequest } from './Journeys'
import { LiveFlightMap } from './LiveFlightMap'
import { feet, legNotes } from './legNotes'
import { restoreSummary } from './RestoreResult'

const REFRESH_MS = 3000
const OFFLINE: LiveSim = {
  connected: false,
  aircraftKey: null,
  aircraftName: null,
  lat: null,
  lon: null,
  onGround: null,
  nearAirport: null,
  headingTrue: null,
  altFt: null,
  gsKts: null,
  paused: false,
  flightId: null
}

type Labels = Map<string, string>
const nameOf = (record: AirframeRecord, labels: Labels) => labels.get(record.key) ?? record.nickname ?? record.snapshot.aircraft.title
const place = (location: { ident: string; name: string } | null) => (location ? `${location.name} (${location.ident})` : 'away from an airport')
const listNames = (records: AirframeRecord[], labels: Labels) => records.map((record) => nameOf(record, labels)).join(', ')

interface HomeProps {
  onJourney: (request: JourneyRequest) => void
  onOpenHangar: () => void
  onOpenLogbook: () => void
}

function WhereYouAre({ live }: { live: LiveSim }) {
  if (!live.connected) return <p className="muted">Microsoft Flight Simulator isn't running.</p>
  if (!live.aircraftName || live.lat === null) return <p className="muted">Connected. Waiting for a flight to load.</p>
  const where = live.onGround === false ? (live.nearAirport ? `in the air near ${place(live.nearAirport)}` : 'in the air') : `at ${place(live.nearAirport)}`
  return (
    <p>
      You're in the <strong>{live.aircraftName}</strong>, {where}.
    </p>
  )
}

function ReadinessLine({ state, start, end, onRestore, restoring, labels, connected }: {
  state: Readiness
  start: string
  end: string
  onRestore: (key: string) => void
  restoring: boolean
  labels: Labels
  connected: boolean
}) {
  switch (state.kind) {
    case 'ready':
      return <p className="ready">You're at {start} in the {state.aircraftName}. Ready when you are.</p>
    case 'flying':
      return (
        <p className="ready">
          On your way{state.aircraftName ? ` in the ${state.aircraftName}` : ''}: {Math.round(state.toGoNm)} nm to {end}.
        </p>
      )
    case 'restore':
      return (
        <div className="readiness-action">
          <p>Your {state.aircraftName} is parked at {start}, but it's loaded somewhere else right now.</p>
          <button disabled={restoring} onClick={() => onRestore(state.aircraftKey)}>
            {restoring ? 'Bringing it back…' : `Put it back at ${start}`}
          </button>
        </div>
      )
    case 'elsewhere':
      return (
        <p>
          {state.here ? `You're at ${state.here.ident}` : "You're somewhere else"}
          {state.aircraftName ? ` in the ${state.aircraftName}` : ''}. This leg starts at {start}.
          {state.parkedHere.length > 0 && ` Parked there: ${listNames(state.parkedHere, labels)}.`}
        </p>
      )
    case 'offline':
      return (
        <p>
          {connected ? `Load a flight at ${start} to fly it.` : `Start the sim at ${start} to fly it.`}
          {state.parkedHere.length > 0 && ` Parked there: ${listNames(state.parkedHere, labels)}.`}
        </p>
      )
  }
}

function NextLeg({ journey, live, airframes, labels, onOpen }: {
  journey: Journey
  live: LiveSim
  airframes: AirframeRecord[]
  labels: Labels
  onOpen: () => void
}) {
  const [restoring, setRestoring] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const progress = progressOf(journey)
  const leg = progress.next
  if (!leg) return null

  const restore = async (key: string) => {
    setRestoring(true)
    setMessage(null)
    try {
      const report: RestoreReport = await window.journeys.restoreAirframe(key, null, null)
      setMessage(restoreSummary(report))
    } catch (e) {
      setMessage(errorText(e))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <article className="next-leg">
      <p className="eyebrow">
        {journey.name} · leg {progress.legNumber} of {progress.legCount} · {Math.round(progress.remainingNm).toLocaleString()} nm to go
      </p>
      <h2 className="next-leg-route">
        {leg.from.ident} <span aria-hidden="true">→</span>
        <span className="sr-only">to</span> {leg.to.ident}
      </h2>
      <p className="muted">
        {leg.from.name} to {leg.to.name}
      </p>
      <div className="next-leg-stats">
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
      </div>
      {legNotes(leg, journey.limits).map((note) => (
        <p key={note} className="note">
          {note}
        </p>
      ))}
      {journey.descent.pauseBeforeTod && (
        <p className="muted">Journeys will pause the sim {journey.descent.minutesBefore} min before top of descent into {leg.to.ident}.</p>
      )}
      <ReadinessLine
        state={readiness(leg, live, airframes)}
        start={leg.from.ident}
        end={leg.to.ident}
        onRestore={restore}
        restoring={restoring}
        labels={labels}
        connected={live.connected}
      />
      {message && <p className="note">{message}</p>}
      <button className="secondary" onClick={onOpen}>
        Open Journey
      </button>
    </article>
  )
}

/** Pinned airports, and a way to start a Journey to any of them. */
function YourPlaces({ places, from, onPlan, onChanged }: { places: Place[]; from: string | undefined; onPlan: (to: string) => void; onChanged: () => void }) {
  const [ident, setIdent] = useState('')
  const [kind, setKind] = useState<PlaceKind>('want')
  const [error, setError] = useState<string | null>(null)
  const label = (k: PlaceKind) => PLACE_KINDS.find((entry) => entry.id === k)!.label

  return (
    <>
      <h3>Your places</h3>
      {places.length === 0 && (
        <p className="muted">Pin your home field, places you've been and places you'd like to fly to, and plan a Journey to any of them in one click.</p>
      )}
      <ul className="home-list places">
        {places.map((place) => (
          <li key={place.id}>
            <span className={`place-kind ${place.kind}`}>{label(place.kind)}</span>
            <strong>{place.ident}</strong>
            <span className="muted">
              {place.name}
              {place.city ? `, ${place.city}` : ''}
            </span>
            {place.ident !== from && (
              <button className="link" onClick={() => onPlan(place.ident)}>
                Plan a Journey here
              </button>
            )}
            <button
              className="link"
              aria-label={`Remove ${place.ident} from your places`}
              onClick={async () => {
                await window.journeys.removePlace(place.id)
                onChanged()
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="fields place-form"
        onSubmit={async (e) => {
          e.preventDefault()
          setError(null)
          try {
            await window.journeys.addPlace(ident, kind, '')
            setIdent('')
            onChanged()
          } catch (err) {
            setError(errorText(err))
          }
        }}
      >
        <AirportInput label="Pin an airport" value={ident} onChange={setIdent} />
        <label className="field small">
          <span>As</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as PlaceKind)}>
            {PLACE_KINDS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={!ident.trim()}>
          Pin it
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export function Home({ onJourney, onOpenHangar, onOpenLogbook }: HomeProps) {
  const [journeys, setJourneys] = useState<Journey[] | null>(null)
  const [places, setPlaces] = useState<Place[]>([])
  const [airframes, setAirframes] = useState<AirframeRecord[]>([])
  const [lastFlight, setLastFlight] = useState<LogbookFlight | null>(null)
  const [live, setLive] = useState<LiveSim>(OFFLINE)

  const load = useCallback(() => {
    void window.journeys.listJourneys().then(setJourneys)
    void window.journeys.listAirframes().then(setAirframes)
    void window.journeys.listPlaces?.().then(setPlaces)
    void window.journeys.listFlights().then((flights) => setLastFlight(flights.find((f) => f.status !== 'in-progress') ?? null))
    // Optional so a window reloaded during development against an older background process still works.
    void window.journeys.liveSim?.().then(setLive)
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    const offUpdated = window.journeys.onJourneyUpdated(load)
    return () => {
      clearInterval(timer)
      offUpdated()
    }
  }, [load])

  const labels = aircraftLabels(airframes)
  // The loaded aircraft goes by the same name as its Hangar card.
  const named: LiveSim = { ...live, aircraftName: (live.aircraftKey && labels.get(live.aircraftKey)) || live.aircraftName }
  const journey = journeys && currentJourney(journeys)
  const others = journeys?.filter((j) => j.status === 'active' && j.id !== journey?.id) ?? []
  // A new Journey starts from where you are, or else where your most recently parked aircraft is.
  const from = named.nearAirport?.ident ?? airframes[0]?.location?.ident
  const plan = (to?: string) => onJourney({ kind: 'plan', from, to })
  const wanted = places.filter((place) => place.kind === 'want' && place.ident !== from)

  const nextLeg = journey ? (progressOf(journey).next ?? null) : null
  return (
    <section className="logbook home">
      <div className="home-layout">
        <aside className="home-live">
          <LiveFlightMap leg={nextLeg} />
        </aside>
        <div className="home-main">
      <WhereYouAre live={named} />

      {journeys && !journey && (
        <article className="next-leg">
          <h2>No Journey under way</h2>
          <p className="muted">Plan a trip and Journeys will line up the next leg here every time you sit down to fly.</p>
          {wanted.length > 0 && (
            <p>
              Somewhere you wanted to go:{' '}
              {wanted.slice(0, 3).map((place, i) => (
                <span key={place.id}>
                  {i > 0 && ', '}
                  <button className="link" onClick={() => plan(place.ident)}>
                    {place.name} ({place.ident})
                  </button>
                </span>
              ))}
            </p>
          )}
          <button onClick={() => plan()}>Plan a Journey</button>
        </article>
      )}
      {journey && (
        <NextLeg journey={journey} live={named} airframes={airframes} labels={labels} onOpen={() => onJourney({ kind: 'open', id: journey.id })} />
      )}

      {others.length > 0 && (
        <>
          <h3>Also under way</h3>
          <ul className="home-list">
            {others.map((other) => {
              const progress = progressOf(other)
              return (
                <li key={other.id}>
                  <button className="link" onClick={() => onJourney({ kind: 'open', id: other.id })}>
                    {other.name}
                  </button>
                  <span className="muted">
                    {progress.next ? `next ${progress.next.from.ident} → ${progress.next.to.ident}` : ''} · leg {progress.legNumber} of {progress.legCount}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <YourPlaces places={places} from={from} onPlan={plan} onChanged={load} />

      {airframes.length > 0 && (
        <>
          <h3>Your aircraft</h3>
          <ul className="home-list">
            {airframes.map((record) => (
              <li key={record.key}>
                <button className="link" onClick={onOpenHangar}>
                  {nameOf(record, labels)}
                </button>
                <span className="muted">{record.location ? `at ${record.location.ident}` : 'away from an airport'}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {lastFlight && (
        <>
          <h3>Last flight</h3>
          <p>
            <button className="link" onClick={onOpenLogbook}>
              {lastFlight.aircraft?.title ?? 'Unknown aircraft'}
            </button>{' '}
            <span className="muted">
              {new Date(lastFlight.startedAt).toLocaleDateString()} · {Math.round(lastFlight.distanceNm)} nm ·{' '}
              {lastFlight.landings.length} {lastFlight.landings.length === 1 ? 'landing' : 'landings'}
            </span>
          </p>
        </>
      )}
        </div>
      </div>
    </section>
  )
}
