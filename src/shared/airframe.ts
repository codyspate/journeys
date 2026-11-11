import type { Snapshot } from './types'

export interface ParkedLocation {
  ident: string
  name: string
}

export interface AirframeRecord {
  key: string
  snapshot: Snapshot
  /** Nearest airport when parked, if there is one close by. */
  location: ParkedLocation | null
  /** The player's own name for this aircraft. */
  nickname?: string
}

/** One entry in an aircraft's history: a place it was parked, or a save the player made. */
export interface AirframeSave {
  id: string
  key: string
  name: string
  kind: 'parked' | 'manual'
  snapshot: Snapshot
  location: ParkedLocation | null
}

export interface RestoreOffer {
  key: string
  title: string
  livery: string
  savedAt: string
  location: ParkedLocation | null
}

export interface Settings {
  saveAircraftLocation: boolean
  /** Only log flights that take off from where the aircraft last landed. */
  noTeleport: boolean
  /** Let AI assistants on this computer read flights through the Journeys MCP server. */
  shareWithAssistants: boolean
  /** Draw flights that ended without landing and parking on the Atlas and aircraft maps. */
  showUnfinishedFlights: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  saveAircraftLocation: true,
  noTeleport: true,
  shareWithAssistants: false,
  showUnfinishedFlights: false
}

/** What the sim is doing right now, for the Home screen. */
export interface LiveSim {
  connected: boolean
  aircraftKey: string | null
  /** The player's name for the aircraft, or its title. */
  aircraftName: string | null
  lat: number | null
  lon: number | null
  onGround: boolean | null
  /** The airport the aircraft is at or over, within a few miles. */
  nearAirport: ParkedLocation | null
  headingTrue: number | null
  altFt: number | null
  gsKts: number | null
  /** True while the sim has paused itself or the player paused it. */
  paused: boolean
  /** The flight being logged right now, if any. */
  flightId: string | null
}

/** Sent when a flight starts somewhere the aircraft isn't, with No teleport on. */
export interface UntrackedFlight {
  aircraft: string
  reason: string
}

export const airframeKey = (title: string, livery: string) => `${title}|${livery}`

/** The title and livery back out of a key. Titles never contain "|", liveries might. */
export function splitAirframeKey(key: string): [string, string] {
  const at = key.indexOf('|')
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)]
}
