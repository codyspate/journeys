/** One landing worth remembering, at the end of a leg. */
export interface SummaryLanding {
  ident: string
  touchdownFpm: number
}

/** One leg singled out, by where it went. */
export interface SummaryLeg {
  from: string
  to: string
  distanceNm: number
}

/** A finished Journey, looked back on: the numbers, the highlights and a few lighter comparisons. */
export interface JourneySummary {
  /** A playful title earned by how the trip went, such as "Border hopper". */
  title: string
  legs: number
  distanceNm: number
  /** The straight line from start to finish. */
  directNm: number
  airMinutes: number
  /** Start of the first leg to the end of the last, as dates on the calendar. Null if no flights were found. */
  startedAt: number | null
  finishedAt: number | null
  fuelGal: number
  landings: number
  /** Airports touched, the start included. */
  airports: number
  /** ISO country codes in the order they were first reached. */
  countries: string[]
  aircraft: string[]
  softest: SummaryLanding | null
  firmest: SummaryLanding | null
  highestFt: number | null
  longestLeg: SummaryLeg | null
  shortestLeg: SummaryLeg | null
  maxG: number | null
  stallWarnings: number
  photos: number
  notes: number
  /** Light comparisons, each one short line. */
  funFacts: string[]
}
