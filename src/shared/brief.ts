/** A light kneeboard for one leg: the ground below, a cruise altitude to consider, checkpoints and the arrival. */
export interface LegBrief {
  legId: string
  /** The ground under the route, sampled evenly from departure to arrival. */
  profile: ProfilePoint[]
  totalNm: number
  cruise: CruiseHint
  /** The wind at the player's aircraft right now, from the sim. null when the sim isn't running. */
  wind: Wind | null
  /** Checkpoints in order, ending at the arrival. */
  navLog: NavLogRow[]
  arrival: Arrival | null
}

export interface ProfilePoint {
  alongNm: number
  groundFt: number
  water: boolean
}

export interface Wind {
  /** Where the wind blows from, true. */
  fromTrue: number
  kts: number
}

export interface CruiseHint {
  /** The leg's overall course, departure to arrival: magnetic when the variation is known, else true. */
  courseDeg: number
  magnetic: boolean
  /** Courses 0–179: odd thousands plus 500. 180–359: even thousands plus 500. */
  eastbound: boolean
  highestGroundFt: number
  suggestedFt: number
  /** The suggestion is held down by the highest altitude you'll fly, so it doesn't clear the ground by your margin. */
  heldByCeiling: boolean
}

export interface NavLogRow {
  name: string
  kind: 'town' | 'airport' | 'vor' | 'arrival'
  /** For airports and VORs. */
  ident: string | null
  /** For VORs, in MHz. */
  frequency: number | null
  lat: number
  lon: number
  /** From the previous row (or the departure). */
  legNm: number
  totalNm: number
  /** Course over the ground to this row, magnetic when the variation is known. */
  courseDeg: number
  /** Heading to hold for the wind, when the wind is known. */
  headingDeg: number | null
  gsKts: number
  legMinutes: number
  totalMinutes: number
  /** Fuel used since departure, at the planned burn. */
  fuelUsedGal: number
}

export interface Arrival {
  ident: string
  name: string
  elevationFt: number
  /** Field elevation plus 1,000 ft, the usual light-aircraft pattern. */
  patternAltitudeFt: number
  runways: ArrivalRunway[]
  /** The end most into the wind at the aircraft now, when there's wind worth landing into. */
  likely: string | null
}

export interface ArrivalRunway {
  ends: [string, string]
  lengthFt: number
  hardSurface: boolean
  /** For the end most into the wind, when the wind and heading are known. */
  headwindKts: number | null
  crosswindKts: number | null
  /** Which end the wind figures are for. */
  windEnd: string | null
}
