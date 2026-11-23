import type { Journey, Leg } from '../shared/journey'
import type { FlightJournal, LogbookFlight } from '../shared/logbook'
import type { JourneySummary, SummaryLanding, SummaryLeg } from '../shared/summary'
import { distanceNm } from './recorder'

/** Once round the equator. */
const AROUND_THE_WORLD_NM = 21_639
const BATHTUB_GAL = 40
const OLYMPIC_POOL_GAL = 660_000
const FILM_MINUTES = 120
const EIFFEL_TOWER_FT = 1_083
const HIGHWAY_KTS = 56

export interface SummaryInput {
  /** Logbook flights by id. A flight deleted from the logbook just leaves its leg's planned numbers. */
  flights: Map<string, LogbookFlight>
  /** The country an airport is in, as an ISO code, if known. */
  countryOf: (ident: string) => string | null
  journals: Record<string, FlightJournal>
}

const number = (n: number) => Math.round(n).toLocaleString('en-US')
const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US')

/** Looks back over a finished Journey: totals, the highlights, and a few lighter comparisons. */
export function journeySummary(journey: Journey, input: SummaryInput): JourneySummary {
  const legs = journey.legs.filter((leg) => leg.status === 'flown')
  const flightOf = (leg: Leg) => (leg.flightId ? input.flights.get(leg.flightId) : undefined)
  const flights = legs.map(flightOf).filter((f): f is LogbookFlight => Boolean(f))

  const distance = legs.reduce((sum, leg) => sum + leg.distanceNm, 0)
  const air = legs.reduce((sum, leg) => sum + leg.minutes, 0)
  const fuel = legs.reduce((sum, leg) => sum + Math.max(0, leg.fuelGal), 0)
  const direct = distanceNm(journey.origin.lat, journey.origin.lon, journey.destination.lat, journey.destination.lon)

  const stops = [journey.origin.ident, ...legs.map((leg) => leg.to.ident)].filter((ident) => ident !== 'OFF-FIELD')
  const countries: string[] = []
  for (const ident of stops) {
    const country = input.countryOf(ident)
    if (country && !countries.includes(country)) countries.push(country)
  }
  const aircraft = [...new Set(legs.map((leg) => leg.aircraft ?? flightOf(leg)?.aircraft?.title).filter((a): a is string => Boolean(a)))]

  // The landing that ended each leg, not touch-and-goes along the way.
  const arrivals: SummaryLanding[] = []
  for (const leg of legs) {
    const last = flightOf(leg)?.landings.at(-1)
    if (last?.touchdownFpm != null) arrivals.push({ ident: leg.to.ident, touchdownFpm: Math.round(last.touchdownFpm) })
  }
  const byRate = [...arrivals].sort((a, b) => a.touchdownFpm - b.touchdownFpm)

  const legsBySize = [...legs].sort((a, b) => b.distanceNm - a.distanceNm)
  const asSummary = (leg: Leg | undefined): SummaryLeg | null =>
    leg ? { from: leg.from.ident, to: leg.to.ident, distanceNm: Math.round(leg.distanceNm) } : null

  const starts = flights.map((f) => f.takeoffAt ?? f.startedAt)
  const ends = flights.map((f) => f.landedAt ?? f.endedAt ?? f.startedAt)
  const highest = flights.length ? Math.max(...flights.map((f) => f.maxAltitudeFt)) : null
  const maxG = flights.length ? Math.max(...flights.map((f) => f.maxG)) : null
  const journals = flights.map((f) => input.journals[f.id]).filter(Boolean)

  const summary: JourneySummary = {
    title: '',
    legs: legs.length,
    distanceNm: Math.round(distance),
    directNm: Math.round(direct),
    airMinutes: Math.round(air),
    startedAt: starts.length ? Math.min(...starts) : null,
    finishedAt: ends.length ? Math.max(...ends) : null,
    fuelGal: Math.round(fuel),
    landings: flights.reduce((sum, f) => sum + f.landings.length, 0),
    airports: new Set(stops).size,
    countries,
    aircraft,
    softest: byRate[0] ?? null,
    firmest: byRate.length > 1 ? byRate[byRate.length - 1] : null,
    highestFt: highest === null ? null : Math.round(highest),
    longestLeg: asSummary(legsBySize[0]),
    shortestLeg: legs.length > 1 ? asSummary(legsBySize[legsBySize.length - 1]) : null,
    maxG: maxG === null ? null : Math.round(maxG * 100) / 100,
    stallWarnings: flights.reduce((sum, f) => sum + f.events.filter((e) => e.type === 'stall').length, 0),
    photos: journals.reduce((sum, j) => sum + j.photoCount, 0),
    notes: journals.filter((j) => j.note.trim()).length,
    funFacts: []
  }
  summary.title = titleFor(summary, arrivals)
  summary.funFacts = funFacts(summary, flights)
  return summary
}

/** A playful title, from the most remarkable thing about the trip. */
function titleFor(s: JourneySummary, arrivals: SummaryLanding[]): string {
  const averageTouchdown = arrivals.length ? arrivals.reduce((sum, a) => sum + a.touchdownFpm, 0) / arrivals.length : Infinity
  if (s.countries.length >= 5) return 'Globetrotter'
  if (s.distanceNm >= 5000) return 'Long-hauler'
  if (s.legs >= 10) return 'Marathon flyer'
  if (s.countries.length >= 2) return 'Border hopper'
  if (arrivals.length >= 2 && averageTouchdown <= 100) return 'Butter merchant'
  if (s.directNm > 0 && s.distanceNm / s.directNm >= 1.5) return 'Scenic-route specialist'
  if (s.legs === 1) return 'One and done'
  return 'Trailblazer'
}

function funFacts(s: JourneySummary, flights: LogbookFlight[]): string[] {
  const facts: string[] = []

  const laps = s.distanceNm / AROUND_THE_WORLD_NM
  if (laps >= 1) facts.push(`Enough miles to go round the world ${oneDecimal(laps)} times.`)
  else if (laps >= 0.02) facts.push(`That's ${number(laps * 100)}% of the way round the world.`)

  if (s.directNm >= 20) {
    const ratio = s.distanceNm / s.directNm
    if (ratio >= 1.3) facts.push(`You flew ${oneDecimal(ratio)}× the straight line. The scenic route, clearly.`)
    else if (ratio <= 1.08) facts.push(`Within ${number(Math.max(0, ratio - 1) * 100)}% of the straight line, start to finish.`)
  }

  if (s.fuelGal >= OLYMPIC_POOL_GAL / 100) facts.push(`${oneDecimal((s.fuelGal / OLYMPIC_POOL_GAL) * 100)}% of an Olympic pool of fuel burned.`)
  else if (s.fuelGal >= BATHTUB_GAL / 2) facts.push(`About ${oneDecimal(s.fuelGal / BATHTUB_GAL)} bathtubs of fuel burned.`)

  if (s.airMinutes >= FILM_MINUTES * 1.5) facts.push(`${oneDecimal(s.airMinutes / 60)} hours aloft: about ${number(s.airMinutes / FILM_MINUTES)} feature films' worth.`)

  const airHours = s.airMinutes / 60
  if (airHours > 0.5 && s.distanceNm > 0) {
    const kts = s.distanceNm / airHours
    facts.push(`Averaged ${number(kts)} kt over the ground, about ${oneDecimal(kts / HIGHWAY_KTS)}× highway speed.`)
  }

  if (s.highestFt !== null && s.highestFt >= EIFFEL_TOWER_FT * 2) facts.push(`Topped out at ${number(s.highestFt)} ft, ${number(s.highestFt / EIFFEL_TOWER_FT)} Eiffel Towers up.`)

  if (s.startedAt !== null && s.finishedAt !== null) {
    const days = calendarDays(s.startedAt, s.finishedAt)
    if (days >= 2) facts.push(`Spread over ${days} days on the calendar.`)
    else if (flights.length > 1) facts.push('All flown in a single day.')
  }
  return facts
}

/** How many dates the trip touched, counted in local time. */
function calendarDays(from: number, to: number): number {
  const day = (t: number) => {
    const d = new Date(t)
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  }
  return Math.round((day(to) - day(from)) / 86_400_000) + 1
}

