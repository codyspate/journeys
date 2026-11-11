import { useEffect, useState } from 'react'
import type { Atlas as AtlasData } from '../../shared/logbook'
import { FlightsMap } from './AircraftMap'

const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** Every logged flight on one map, with the airports and countries they've reached. */
export function Atlas() {
  const [atlas, setAtlas] = useState<AtlasData | null>(null)
  useEffect(() => {
    let current = true
    void Promise.resolve()
      .then(() => window.journeys.atlas())
      .then((loaded) => current && setAtlas(loaded))
      .catch(() => current && setAtlas({ flights: [], airports: [], countries: [] }))
    return () => {
      current = false
    }
  }, [])

  return (
    <section className="atlas" aria-label="Atlas">
      <h3>Atlas</h3>
      <FlightsMap
        flights={atlas?.flights ?? null}
        label="Map of every flight in your logbook"
        emptyText="Your flights will draw here as you finish them. Unfinished ones can be shown on maps from Settings."
        showAircraft
      >
        {atlas && atlas.airports.length > 0 && (
          <p className="atlas-reach">
            <strong>{atlas.airports.length}</strong> {atlas.airports.length === 1 ? 'airport' : 'airports'} visited in{' '}
            <strong>{atlas.countries.length}</strong> {atlas.countries.length === 1 ? 'country' : 'countries'}:{' '}
            <span className="muted">{atlas.countries.map(countryName).join(', ')}</span>
          </p>
        )}
      </FlightsMap>
      <p className="muted">Click a flight in the table below for its own map, notes and photos.</p>
    </section>
  )
}
