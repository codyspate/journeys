import { useCallback, useEffect, useState } from 'react'
import type { FlightJournal, FlightPhoto, FlightStatus, LogbookFlight } from '../../shared/logbook'
import { Atlas } from './Atlas'
import { FlightJournalPanel, Lightbox } from './FlightJournal'
import { FlightMap } from './FlightMap'

const REFRESH_MS = 5000

const STATUS_LABEL: Record<FlightStatus, string> = {
  'in-progress': 'In progress',
  complete: 'Complete',
  'ended-early': 'Ended early',
  interrupted: 'Interrupted'
}

function duration(from: number | null, to: number | null): string {
  if (from === null || to === null) return '—'
  const minutes = Math.round((to - from) / 60000)
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
function FlightDetail({ flight, onClose }: { flight: LogbookFlight; onClose: () => void }) {
  const [photos, setPhotos] = useState<FlightPhoto[]>([])
  const [open, setOpen] = useState<number | null>(null)
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
        <button className="link" onClick={onClose}>
          Close flight
        </button>
      </div>
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
        <FlightDetail key={selected.id} flight={selected} onClose={() => setSelectedId(null)} />
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
                <td>{duration(flight.startedAt, flight.endedAt)}</td>
                <td>{duration(flight.takeoffAt, flight.landedAt)}</td>
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
