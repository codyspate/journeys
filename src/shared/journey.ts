export type AirportSize = 'small' | 'medium' | 'large'

export interface Airport {
  ident: string
  name: string
  lat: number
  lon: number
  elevationFt: number
  size: AirportSize
  city: string
  country: string
  runwayFt: number
  hardSurface: boolean
  scheduled: boolean
  /** Other codes the same airport goes by, such as its GPS or local code. */
  codes?: string[]
}

export type PlaceKind = 'home' | 'been' | 'want'

export const PLACE_KINDS: { id: PlaceKind; label: string }[] = [
  { id: 'want', label: 'Want to go' },
  { id: 'home', label: 'Home field' },
  { id: 'been', label: 'Been there' }
]

/** An airport the player pinned, to give them somewhere to aim for. */
export interface Place {
  id: string
  ident: string
  name: string
  city: string
  lat: number
  lon: number
  kind: PlaceKind
  note: string
}

export interface Stop {
  ident: string
  name: string
  lat: number
  lon: number
}

export interface Performance {
  name: string
  cruiseKts: number
  burnGph: number
  usableFuelGal: number
  reserveMinutes: number
  minRunwayFt: number
  needsHardSurface: boolean
}

/** Rough starting points. Players can edit every number per Journey. */
export const PERFORMANCE_PRESETS: Performance[] = [
  { name: 'A2A Comanche 250', cruiseKts: 160, burnGph: 14, usableFuelGal: 60, reserveMinutes: 45, minRunwayFt: 2000, needsHardSurface: false },
  { name: 'Cessna 172', cruiseKts: 120, burnGph: 9, usableFuelGal: 53, reserveMinutes: 45, minRunwayFt: 1500, needsHardSurface: false },
  { name: 'Narrowbody airliner', cruiseKts: 450, burnGph: 800, usableFuelGal: 6300, reserveMinutes: 45, minRunwayFt: 6000, needsHardSurface: true },
  { name: 'Fighter jet', cruiseKts: 480, burnGph: 1100, usableFuelGal: 1600, reserveMinutes: 20, minRunwayFt: 7000, needsHardSurface: true }
]

/** Optional limits that steer which stops the planner suggests. null means off. */
export interface RouteLimits {
  maxLegNm: number | null
  /** Discourages stops that make a leg shorter than this. */
  minLegNm: number | null
  /** The highest altitude you want to fly. Legs whose terrain comes within the clearance are avoided. */
  maxAltitudeFt: number | null
  terrainClearanceFt: number
  maxAirportElevationFt: number | null
  maxWaterNm: number | null
}

export const NO_LIMITS: RouteLimits = {
  maxLegNm: null,
  minLegNm: null,
  maxAltitudeFt: null,
  terrainClearanceFt: 1000,
  maxAirportElevationFt: null,
  maxWaterNm: null
}

/** Optional pause before top of descent, so there's time to set up the arrival. */
export interface DescentSettings {
  pauseBeforeTod: boolean
  minutesBefore: number
  angleDeg: number
  arriveAboveFieldFt: number
}

export const DEFAULT_DESCENT: DescentSettings = { pauseBeforeTod: false, minutesBefore: 2, angleDeg: 3, arriveAboveFieldFt: 1500 }

export interface TopOfDescent {
  ident: string
  name: string
  distanceToTargetNm: number
  /** How far out descent starts, measured back from the stop. */
  descentNm: number
  distanceToTodNm: number
  minutesToTod: number
  fromAltFt: number
  toAltFt: number
}

export interface JourneySettings {
  performance: Performance
  maxLegMinutes: number
  limits: RouteLimits
  descent: DescentSettings
}

export interface Leg {
  id: string
  from: Stop
  to: Stop
  status: 'planned' | 'flown'
  distanceNm: number
  minutes: number
  fuelGal: number
  /** Longer than the aircraft can fly with reserve. Informational only. */
  beyondRange: boolean
  /** Longer than the preferred session. Informational only. */
  beyondSession: boolean
  /** Highest ground under the direct line, when terrain data is available. */
  highestTerrainFt?: number | null
  /** Longest unbroken stretch over water on the direct line. */
  longestWaterNm?: number | null
  /** Terrain comes closer than the clearance to the highest altitude you want to fly. Informational only. */
  aboveCeiling?: boolean
  /** Crosses more water than you said you're happy with. Informational only. */
  overWater?: boolean
  /** Shorter than your shortest leg. Informational only. */
  belowMinimum?: boolean
  /** The arrival is a stop the player chose. */
  pinned: boolean
  confidence: 'firm' | 'tentative'
  flightId: string | null
  aircraft: string | null
}

export interface Journey {
  id: string
  name: string
  createdAt: number
  lastOpenedAt: number
  status: 'active' | 'complete'
  origin: Stop
  destination: Stop
  /** Stops the player chose that haven't been reached yet. */
  via: Stop[]
  /** Airports the player took off the route, so the planner won't choose them again. */
  avoid: string[]
  performance: Performance
  maxLegMinutes: number
  limits: RouteLimits
  descent: DescentSettings
  legs: Leg[]
}

export interface CreateJourneyInput {
  name: string
  originIdent: string
  destinationIdent: string
  performance: Performance
  maxLegMinutes: number
  limits?: RouteLimits
  descent?: DescentSettings
}

export type RouteEdit =
  | { kind: 'add'; ident: string }
  | { kind: 'remove'; ident: string }
  | { kind: 'replace'; ident: string; withIdent: string }
  | { kind: 'move'; ident: string; offset: -1 | 1 }
  /** A stop dragged to a different airport. Everything before it stays as it is. */
  | { kind: 'drag'; ident: string; withIdent: string; rest: 'keep' | 'replan' }
  | { kind: 'origin'; ident: string }
  | { kind: 'destination'; ident: string }
  | { kind: 'reset' }

export interface ReachChoice {
  stop: Stop
  distanceNm: number
  reserveMinutes: number
}

export interface ReachOptions {
  journeyId: string
  plannedStop: Stop
  distanceToPlannedNm: number
  reserveAtPlannedMinutes: number
  canReachPlanned: boolean
  /** A stop past the plan that fuel and groundspeed now allow. */
  further: ReachChoice | null
  /** The best stop short of the plan, when the plan is out of reach. */
  closer: ReachChoice | null
}
