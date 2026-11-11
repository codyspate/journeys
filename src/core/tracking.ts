import type { ParkedLocation } from '../shared/airframe'
import type { TelemetrySample } from '../shared/logbook'
import type { RecorderOutput } from './recorder'
import { distanceNm } from './recorder'

/** Taking off this close to where the aircraft last landed counts as the same place. */
export const SAME_PLACE_NM = 3

/** Where an aircraft really is, as far as Journeys knows. */
export interface Home {
  lat: number
  lon: number
  location: ParkedLocation | null
}

/** Why an aircraft isn't being tracked here, or null if it is. */
export function awayFromHome(home: Home | null, lat: number, lon: number): string | null {
  if (!home) return null
  if (distanceNm(home.lat, home.lon, lat, lon) <= SAME_PLACE_NM) return null
  return home.location ? `It's at ${home.location.name} (${home.location.ident}).` : "It's still where it last landed."
}

export type Decision =
  | { persist: true }
  | { persist: false; untrackedReason?: string }

/**
 * With No teleport on, a flight only goes in the logbook if it took off from where the aircraft last landed.
 * Decided once when the flight starts, then applied to everything the recorder says about that flight.
 */
export class FlightGate {
  private readonly ignored = new Set<string>()

  constructor(
    private readonly noTeleport: () => boolean,
    /** Why the loaded aircraft isn't at home here, or null if it is (or isn't known yet). */
    private readonly reasonAt: (sample: TelemetrySample) => string | null
  ) {}

  decide(output: RecorderOutput, sample: TelemetrySample): Decision {
    if (output.kind === 'none') return { persist: true }
    const id = output.kind === 'discarded' ? output.flightId : output.flight.id
    if (output.kind === 'sample' && output.started && this.noTeleport()) {
      const reason = this.reasonAt(sample)
      if (reason) {
        this.ignored.add(id)
        return { persist: false, untrackedReason: reason }
      }
    }
    if (!this.ignored.has(id)) return { persist: true }
    if (output.kind !== 'sample') this.ignored.delete(id)
    return { persist: false }
  }

  /** True while the current flight is one that isn't being logged. */
  isIgnoring(flightId: string | null): boolean {
    return flightId !== null && this.ignored.has(flightId)
  }
}
