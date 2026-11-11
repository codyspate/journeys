import { type AirframeRecord, airframeKey, type RestoreOffer, type Settings } from '../shared/airframe'
import { catalogFor, profileById } from '../shared/catalog'
import { SIM_PAUSED_ITSELF, type TelemetrySample } from '../shared/logbook'
import type { AircraftInfo, RestoreOptions, RestoreReport, Snapshot } from '../shared/types'
import { hasPosition } from './recorder'
import { captureSnapshot, compareState, DEFAULT_TIMING, restoreSnapshot, type RestoreTiming, type SimPort } from './restore'

const MOVING_KTS = 3
const STOPPED_KTS = 1
const PARK_CONFIRM_MS = 5000
const CHECKPOINT_INTERVAL_MS = 15_000

export interface AirframeStore {
  get(key: string): AirframeRecord | null
  save(key: string, snapshot: Snapshot): void
}

type State = 'loading' | 'identifying' | 'awaiting' | 'restoring' | 'tracking'

const isParked = (s: TelemetrySample) =>
  Boolean(s.onGround) &&
  s.gsKts < STOPPED_KTS &&
  // Ending the flight from the sim's menu counts too: the sim pauses itself with the engines still running.
  (Boolean(s.parkingBrake) || !(s.engine1 || s.engine2 || s.engine3 || s.engine4) || Boolean((s.pauseFlags ?? 0) & SIM_PAUSED_ITSELF))

/**
 * Remembers each aircraft while parked and offers to bring it back on load.
 * A saved state is only ever replaced after the player has restored it, or flown.
 */
export class AirframeTracker {
  private state: State = 'loading'
  private generation = 0
  private key: string | null = null
  private pending: AirframeRecord | null = null
  /** False protects the saved state from a fresh spawn the player hasn't committed to. */
  private armed = false
  private parkedSince: number | null = null
  private lastCheckpoint = -Infinity
  private checkpointing = false

  constructor(
    private readonly port: SimPort,
    private readonly store: AirframeStore,
    private readonly settings: () => Settings,
    private readonly onOffer: (offer: RestoreOffer | null) => void,
    private readonly timing: RestoreTiming = DEFAULT_TIMING,
    /**
     * With No teleport on: why this aircraft shouldn't be saved here, or null if it may be.
     * Keeps a save made somewhere else from moving where the aircraft really is.
     */
    private readonly awayReason: (key: string, lat: number, lon: number) => string | null = () => null
  ) {}

  private reasonNotToSave(key: string, snapshot: Snapshot): string | null {
    const lat = snapshot.values['position.latitude']
    const lon = snapshot.values['position.longitude']
    return lat == null || lon == null ? null : this.awayReason(key, lat, lon)
  }

  ingest(sample: TelemetrySample): void {
    if (!hasPosition(sample)) {
      if (this.state !== 'loading') this.reset()
      return
    }

    if (this.state === 'loading') {
      void this.identify(this.settings().saveAircraftLocation)
      return
    }
    if (this.state === 'identifying' || this.state === 'restoring') return

    const moving = sample.gsKts > MOVING_KTS
    if (this.state === 'awaiting') {
      if (moving) {
        this.decline()
        this.armed = true
      }
      return
    }

    if (moving) this.armed = true
    if (!isParked(sample)) {
      this.parkedSince = null
      return
    }
    this.parkedSince ??= sample.t
    if (
      this.armed &&
      this.settings().saveAircraftLocation &&
      !this.checkpointing &&
      sample.t - this.parkedSince >= PARK_CONFIRM_MS &&
      sample.t - this.lastCheckpoint >= CHECKPOINT_INTERVAL_MS
    ) {
      this.lastCheckpoint = sample.t
      void this.checkpoint(sample.t)
    }
  }

  /** Call when the sim connection drops or a new flight begins loading. */
  reset(): void {
    this.generation++
    this.state = 'loading'
    this.key = null
    this.armed = false
    this.parkedSince = null
    this.lastCheckpoint = -Infinity
    if (this.pending) {
      this.pending = null
      this.onOffer(null)
    }
  }

  async accept(): Promise<RestoreReport> {
    const record = this.pending
    if (this.state !== 'awaiting' || !record) throw new Error('There is nothing to restore right now.')
    const generation = this.generation
    this.state = 'restoring'
    this.pending = null
    this.onOffer(null)
    try {
      const profile = profileById(record.snapshot.profileId)
      return await restoreSnapshot(this.port, record.snapshot, { categories: profile.restore, positionMethod: 'initposition' }, this.timing)
    } finally {
      if (generation === this.generation) {
        this.state = 'tracking'
        this.armed = true
        this.parkedSince = null
      }
    }
  }

  /** Which aircraft is loaded right now, if the sim says. */
  get currentKey(): string | null {
    return this.key
  }

  /**
   * Restores a save the player picked in the Hangar onto the aircraft that's loaded.
   * Afterwards the tracker saves this aircraft as normal again.
   */
  async restoreNow(key: string, snapshot: Snapshot, options?: RestoreOptions): Promise<RestoreReport> {
    if (this.state === 'identifying' || this.state === 'restoring' || this.state === 'loading') {
      throw new Error('Wait for the sim to finish loading the aircraft, then try again.')
    }
    await this.requireLoaded(key, 'Load this aircraft in the sim to restore it.')
    if (this.pending) {
      this.pending = null
      this.onOffer(null)
    }
    const generation = this.generation
    this.state = 'restoring'
    try {
      const profile = profileById(snapshot.profileId)
      return await restoreSnapshot(
        this.port,
        snapshot,
        options ?? { categories: profile.restore, positionMethod: 'initposition' },
        this.timing
      )
    } finally {
      if (generation === this.generation) {
        this.state = 'tracking'
        this.armed = true
        this.parkedSince = null
      }
    }
  }

  /** Reads the loaded aircraft's state for a save the player asked for. */
  async captureNow(key: string): Promise<Snapshot> {
    const aircraft = await this.requireLoaded(key, 'Load this aircraft in the sim to save it.')
    const snapshot = await captureSnapshot(this.port, aircraft.title, new Date(), key)
    const away = this.reasonNotToSave(key, snapshot)
    if (away) throw new Error(`No teleport is on, so this aircraft can only be saved where it last landed. ${away} Restore it there first, or turn off No teleport.`)
    // Saving on purpose replaces any state that was waiting to be restored.
    if (this.pending?.key === key) this.decline()
    this.armed = true
    return snapshot
  }

  private async requireLoaded(key: string, message: string): Promise<AircraftInfo> {
    let aircraft: AircraftInfo
    try {
      aircraft = await this.port.readAircraft()
    } catch {
      throw new Error(message)
    }
    if (airframeKey(aircraft.title, aircraft.livery) !== key) throw new Error(message)
    this.key = key
    return aircraft
  }

  decline(): void {
    if (this.state !== 'awaiting') return
    this.state = 'tracking'
    this.pending = null
    this.onOffer(null)
  }

  /** Call when the player deletes a save, so it doesn't come straight back while the aircraft sits parked. */
  forget(key: string): void {
    if (this.pending?.key === key) this.decline()
    if (this.key === key) this.armed = false
  }

  /** Works out which aircraft is loaded, and offers its saved state if `offer` is on. */
  private async identify(offer: boolean): Promise<void> {
    const generation = this.generation
    this.state = 'identifying'
    try {
      const aircraft = await this.port.readAircraft()
      if (generation !== this.generation) return
      this.key = airframeKey(aircraft.title, aircraft.livery)
      const record = offer ? this.store.get(this.key) : null
      if (!record) {
        this.armed = true
        this.state = 'tracking'
        return
      }

      if (await this.matchesCurrent(record)) {
        if (generation !== this.generation) return
        this.armed = true
        this.state = 'tracking'
        return
      }
      if (generation !== this.generation) return

      this.pending = record
      this.state = 'awaiting'
      this.onOffer({
        key: record.key,
        title: record.nickname ?? record.snapshot.aircraft.title,
        livery: record.snapshot.aircraft.livery,
        savedAt: record.snapshot.capturedAt,
        location: record.location
      })
    } catch {
      if (generation === this.generation) this.state = 'tracking'
    }
  }

  private async matchesCurrent(record: AirframeRecord): Promise<boolean> {
    const profile = profileById(record.snapshot.profileId)
    const catalog = catalogFor(profile)
    const current = await this.port.readNumbers(catalog)
    return !compareState(catalog, record.snapshot.values, current, profile.restore, record.snapshot.engineCount).some(
      (row) => row.status === 'mismatch'
    )
  }

  private async checkpoint(t: number): Promise<void> {
    const generation = this.generation
    this.checkpointing = true
    try {
      const aircraft = await this.port.readAircraft()
      const key = airframeKey(aircraft.title, aircraft.livery)
      const snapshot = await captureSnapshot(this.port, aircraft.title, new Date(t), key)
      const allowed = generation === this.generation && this.state === 'tracking' && this.armed
      if (allowed && !this.reasonNotToSave(key, snapshot)) this.store.save(key, snapshot)
    } catch {
      // The next checkpoint will try again.
    } finally {
      this.checkpointing = false
    }
  }
}
