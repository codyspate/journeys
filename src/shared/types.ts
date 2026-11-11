import type { AirframeRecord, AirframeSave, LiveSim, RestoreOffer, Settings, UntrackedFlight } from './airframe'
import type { Airport, CreateJourneyInput, Journey, JourneySettings, Place, PlaceKind, ReachOptions, RouteEdit, TopOfDescent } from './journey'
import type { AircraftFlight, Atlas, FlightJournal, FlightPhoto, LogbookFlight, PhotoSettings, TrackPoint } from './logbook'

/** Where the app stands with updates. `current` is the running version. */
export type UpdateState =
  | { kind: 'development' | 'idle' | 'checking' | 'up-to-date'; current: string }
  | { kind: 'downloading'; current: string; version: string }
  | { kind: 'ready'; current: string; version: string; notes: string | null }
  | { kind: 'error'; current: string; message: string }

/** What a backup folder holds, from its description file. */
export interface BackupManifest {
  app: 'Journeys'
  version: number
  createdAt: string
  flights: number
  journeys: number
  aircraft: number
}

export const CATEGORIES =['position', 'fuel', 'controls', 'electrical', 'lights', 'custom'] as const
export type Category = (typeof CATEGORIES)[number]

export type RestoreMethod =
  | { kind: 'position' }
  | { kind: 'set' }
  | { kind: 'toggle'; event: string; value?: number }
  | { kind: 'value-event'; event: string }

export interface StateVar {
  id: string
  label: string
  simvar: string
  unit: string
  category: Category
  /** Lower phases are restored first, so power comes up before what depends on it. */
  phase: number
  restore: RestoreMethod
  tolerance: number
  /** Compare with 360 degree wraparound. */
  angular?: boolean
  /** 1-based engine number. Skipped when the aircraft has fewer engines. */
  engine?: number
}

export type StateValues = Record<string, number | null>

export interface AircraftInfo {
  title: string
  livery: string
  atcId: string
}

export interface Snapshot {
  id: string
  name: string
  capturedAt: string
  aircraft: AircraftInfo
  profileId: string
  engineCount: number
  /** False if the aircraft was moving or airborne at capture. */
  parked: boolean
  values: StateValues
}

export type PositionMethod = 'initposition' | 'simvars'

export interface RestoreOptions {
  categories: Category[]
  positionMethod: PositionMethod
}

export type RowStatus = 'restored' | 'mismatch' | 'unavailable' | 'skipped'

export interface ReportRow {
  id: string
  label: string
  category: Category
  target: number | null
  actual: number | null
  status: RowStatus
}

export interface RestoreReport {
  positionMethod: PositionMethod | null
  durationMs: number
  rows: ReportRow[]
  warnings: string[]
}

export interface SimStatus {
  connected: boolean
  simName: string | null
}

export interface JourneysApi {
  getStatus(): Promise<SimStatus>
  /** Where the loaded aircraft is right now. */
  liveSim(): Promise<LiveSim>
  onStatus(listener: (status: SimStatus) => void): () => void
  listFlights(): Promise<LogbookFlight[]>
  flightTrack(flightId: string): Promise<TrackPoint[]>
  /** Every logged flight, and the airports and countries they reached. */
  atlas(): Promise<Atlas>
  flightNote(flightId: string): Promise<string>
  /** A blank note removes it. Returns the note as saved. */
  setFlightNote(flightId: string, text: string): Promise<string>
  flightPhotos(flightId: string): Promise<FlightPhoto[]>
  flightJournals(flightIds: string[]): Promise<Record<string, FlightJournal>>
  /** Asks the player to pick images, then attaches them. */
  addFlightPhotos(flightId: string): Promise<FlightPhoto[]>
  deleteFlightPhoto(id: string): Promise<void>
  photoSettings(): Promise<PhotoSettings>
  updatePhotoSettings(changes: Partial<PhotoSettings>): Promise<PhotoSettings>
  /** Asks the player to pick a folder. null if they cancel. */
  choosePhotoFolder(): Promise<string | null>
  /** Screenshots were attached to a flight after it ended. */
  onPhotosAdded(listener: (flightId: string) => void): () => void
  searchAirports(query: string): Promise<Airport[]>
  listAirports(): Promise<Airport[]>
  listJourneys(): Promise<Journey[]>
  /** Whether AI assistants can connect right now, and what an MCP client needs to start the Journeys server. */
  assistantSetup(): Promise<{ running: boolean; script: string; node: string; userData: string }>
  /** Asks where to save, then writes a dated backup folder there. null if the player cancels. */
  writeBackup(): Promise<{ folder: string; manifest: BackupManifest } | null>
  /** Asks for a backup folder and describes it, without changing anything. */
  chooseBackup(): Promise<{ folder: string; manifest: BackupManifest } | null>
  /** Restarts the app with the backup in place, setting the current data aside. */
  restoreBackup(folder: string): Promise<void>
  updateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  /** Restarts into a downloaded update. Refused while a flight is being recorded. */
  installUpdate(): Promise<void>
  onUpdateState(listener: (state: UpdateState) => void): () => void
  /** Where the data from before the last restore was set aside, if this start applied one. */
  restoredFrom(): Promise<string | null>
  listPlaces(): Promise<Place[]>
  /** Pins an airport, or changes how an already pinned one is marked. */
  addPlace(ident: string, kind: PlaceKind, note: string): Promise<Place>
  removePlace(id: string): Promise<void>
  createJourney(input: CreateJourneyInput): Promise<Journey>
  openJourney(id: string): Promise<Journey>
  updateJourneySettings(id: string, settings: JourneySettings): Promise<Journey>
  hasTerrain(): Promise<boolean>
  editRoute(id: string, edit: RouteEdit): Promise<Journey>
  renameJourney(id: string, name: string): Promise<Journey>
  deleteJourney(id: string): Promise<void>
  onReach(listener: (reach: ReachOptions) => void): () => void
  onJourneyUpdated(listener: (journey: Journey) => void): () => void
  /** Journeys paused the sim ahead of top of descent. */
  onDescentPause(listener: (tod: TopOfDescent) => void): () => void
  listAirframes(): Promise<AirframeRecord[]>
  renameAirframe(key: string, nickname: string): Promise<AirframeRecord>
  deleteAirframe(key: string): Promise<void>
  /** The key of the aircraft loaded in the sim, if known. */
  loadedAirframe(): Promise<string | null>
  /** Every recorded flight in this aircraft, with its path. */
  airframeFlights(key: string): Promise<AircraftFlight[]>
  airframeHistory(key: string): Promise<AirframeSave[]>
  saveAirframe(key: string, name: string): Promise<AirframeSave>
  /** Restores the aircraft's current save, or one from its history. */
  restoreAirframe(key: string, saveId: string | null, options: RestoreOptions | null): Promise<RestoreReport>
  renameAirframeSave(id: string, name: string): Promise<AirframeSave>
  deleteAirframeSave(id: string): Promise<void>
  getSettings(): Promise<Settings>
  updateSettings(changes: Partial<Settings>): Promise<Settings>
  getOffer(): Promise<RestoreOffer | null>
  acceptOffer(): Promise<RestoreReport>
  declineOffer(): Promise<void>
  onOffer(listener: (offer: RestoreOffer | null) => void): () => void
  /** A flight isn't being logged because No teleport is on and the aircraft is elsewhere; null clears it. */
  onUntracked(listener: (untracked: UntrackedFlight | null) => void): () => void
}
