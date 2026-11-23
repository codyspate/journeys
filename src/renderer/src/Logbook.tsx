import { useCallback, useEffect, useState } from 'react'
import { airMinutes, blockMinutes, type FlightJournal, type FlightPhoto, type FlightStatus, type LogbookFlight } from '../../shared/logbook'
import { Atlas } from './Atlas'
import { errorText } from './errors'
import { FlightJournalPanel, Lightbox } from './FlightJournal'
import { FlightMap } from './FlightMap'

const REFRESH_MS = 5000

const STATUS_LABEL: Record<FlightStatus, string> = {
  'in-progress': 'In progress',
  complete: 'Complete',
  'ended-early': 'Ended early',
  interrupted: 'Interrupted'
}

/** Sim time, so a flight flown at 4x shows how long it took in the sim. */
function duration(simMinutes: number | null): string {
  if (simMinutes === null) return '—'
  const minutes = Math.round(simMinutes)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

function landingSummary(flight: LogbookFlight): string {
  const landing = flight.landings.at(-1)
  if (!landing) return '—'
  const rate = landing.touchdownFpm === null ? '—' : `${Math.round(landing.touchdownFpm)} fpm`
  const bounces = landing.bounces > 0 ? `, ${landing.bounces} bounce${landing.bounces > 1 ? 's' : ''}` : ''
  return `${rate}${bounces}`
}

/** One flight opened from the table: its map, note and photos. */
function FlightDetail({ flight, onClose, onDeleted }: { flight: LogbookFlight; onClose: () => void; onDeleted: () => void }) {
  const [photos, setPhotos] = useState<FlightPhoto[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = () =>
    window.journeys.deleteFlight(flight.id).then(onDeleted, (e) => setError(errorText(e)))
  const loadPhotos = useCallback(() => void window.journeys.flightPhotos?.(flight.id).then(setPhotos), [flight.id])
  useEffect(() => {
    loadPhotos()
    return window.journeys.onPhotosAdded?.((id) => id === flight.id && loadPhotos())
  }, [flight.id, loadPhotos])

  return (
    <div className="flight-detail">
      <div className="history-line">
        <strong>
          {flight.aircraft?.title ?? 'Unknown aircraft'} · {new Date(flight.startedAt).toLocaleString()}
        </strong>
        <span className="banner-actions">
          {flight.status !== 'in-progress' && (
            <button className="link" onClick={() => setDeleting(true)}>
              Delete flight
            </button>
          )}
          <button className="link" onClick={onClose}>
            Close flight
          </button>
        </span>
      </div>
      {deleting && (
        <div className="save-actions">
          <span>
            Delete this flight? Its track, note and photos go too, and if it was the latest leg of a Journey, the Journey
            picks up again from where the flight started. This can't be undone.
          </span>
          <button onClick={() => void remove()}>Delete</button>
          <button className="link" onClick={() => setDeleting(false)}>
            Keep it
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <FlightMap flight={flight} photos={photos} onOpenPhoto={(id) => setOpen(photos.findIndex((p) => p.id === id))} />
      <FlightJournalPanel flightId={flight.id} photos={photos} onPhotosChanged={loadPhotos} onOpenPhoto={setOpen} />
      {open !== null && open >= 0 && <Lightbox photos={photos} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  )
}

export function Logbook() {
  const [flights, setFlights] = useState<LogbookFlight[] | null>(null)
  const [journals, setJournals] = useState<Record<string, FlightJournal>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = flights?.find((flight) => flight.id === selectedId) ?? null

  useEffect(() => {
    const load = () =>
      void window.journeys.listFlights().then((loaded) => {
        setFlights(loaded)
        void window.journeys.flightJournals?.(loaded.map((f) => f.id)).then(setJournals)
      })
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  const toggle = (id: string) => setSelectedId((current) => (current === id ? null : id))
  const journalLabel = (id: string) => {
    const entry = journals[id]
    if (!entry) return ''
    const parts = [entry.note ? 'Note' : '', entry.photoCount ? `${entry.photoCount} ${entry.photoCount === 1 ? 'photo' : 'photos'}` : '']
    return parts.filter(Boolean).join(' · ')
  }

  return (
    <section className="logbook">
      <h2>Logbook</h2>
      {flights?.length === 0 && <p className="muted">Flights appear here automatically once you start moving.</p>}
      {selected ? (
        <FlightDetail
          key={selected.id}
          flight={selected}
          onClose={() => setSelectedId(null)}
          onDeleted={() => {
            setFlights((all) => all?.filter((f) => f.id !== selected.id) ?? null)
            setSelectedId(null)
          }}
        />
      ) : (
        flights && flights.length > 0 && <Atlas />
      )}
      {flights && flights.length > 0 && (
        <table className="flights">
          <thead>
            <tr>
              <th>Date</th>
              <th>Aircraft</th>
              <th>Block</th>
              <th>Air</th>
              <th>Distance</th>
              <th>Max alt</th>
              <th>Fuel used</th>
              <th>Landing</th>
              <th>Status</th>
              <th>Journal</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((flight) => (
              <tr
                key={flight.id}
                className={flight.id === selectedId ? 'selected' : ''}
                tabIndex={0}
                aria-selected={flight.id === selectedId}
                onClick={() => toggle(flight.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(flight.id))}
              >
                <td>{new Date(flight.startedAt).toLocaleString()}</td>
                <td>{flight.aircraft?.title ?? 'Unknown'}</td>
                <td>{duration(blockMinutes(flight))}</td>
                <td>{duration(airMinutes(flight))}</td>
                <td>{flight.distanceNm.toFixed(0)} nm</td>
                <td>{Math.round(flight.maxAltitudeFt).toLocaleString()} ft</td>
                <td>{(flight.fuelStartGal - flight.fuelEndGal).toFixed(1)} gal</td>
                <td>{landingSummary(flight)}</td>
                <td>{STATUS_LABEL[flight.status]}</td>
                <td className="muted">{journalLabel(flight.id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
