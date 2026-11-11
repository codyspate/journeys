import { type FlightEvent, isRealPosition, type LandingRecord, type LogbookFlight, SIM_PAUSED_ITSELF, type TelemetrySample } from '../shared/logbook'

const START_MOVING_KTS = 3
const START_AIRBORNE_KTS = 30
const STOPPED_KTS = 1
const PARK_CONFIRM_MS = 5000
const AIRBORNE_CONFIRM_MS = 3000
const BOUNCE_MAX_MS = 8000
const LANDING_WINDOW_MS = 3000
const JUMP_MARGIN_NM = 2
const JUMP_SPEED_FACTOR = 3
/** This long on the sim's placeholder position means the player went back to the main menu. */
const LEFT_FLIGHT_MS = 20_000

export type RecorderOutput =
  | { kind: 'none' }
  | { kind: 'sample'; flight: LogbookFlight; started: boolean }
  | { kind: 'finished'; flight: LogbookFlight }
  | { kind: 'discarded'; flightId: string }

type Phase = 'idle' | 'ground' | 'air'

const NONE: RecorderOutput = { kind: 'none' }

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function windComponents(windKts: number, windDirTrue: number, headingTrue: number) {
  const angle = ((windDirTrue - headingTrue) * Math.PI) / 180
  return { headwindKts: windKts * Math.cos(angle), crosswindKts: Math.abs(windKts * Math.sin(angle)) }
}

export const hasPosition = (s: Pick<TelemetrySample, 'lat' | 'lon'>) => isRealPosition(s.lat, s.lon)
const enginesRunning = (s: TelemetrySample) => Boolean(s.engine1 || s.engine2 || s.engine3 || s.engine4)

/** Turns a stream of telemetry into logbook flights. Knows nothing about the sim or storage. */
export class FlightRecorder {
  private phase: Phase = 'idle'
  private flight: LogbookFlight | null = null
  private last: TelemetrySample | null = null
  private airborneSince = 0
  private parkedSince: number | null = null
  private placeholderSince: number | null = null

  constructor(private readonly newId: () => string) {}

  ingest(sample: TelemetrySample): RecorderOutput {
    // A placeholder position (sim loading, or a menu) is not a move, so a brief one is skipped and can't
    // look like a teleport. Staying on it means the player left the flight for the main menu.
    if (!hasPosition(sample)) {
      this.placeholderSince ??= sample.t
      if (this.flight && this.last && sample.t - this.placeholderSince >= LEFT_FLIGHT_MS) return this.finish('ended-early', this.last.t)
      return NONE
    }
    this.placeholderSince = null

    const previous = this.last
    this.last = sample

    if (this.flight && previous && this.isJump(previous, sample)) {
      return this.finish('ended-early', previous.t)
    }

    let started = false
    if (!this.flight) {
      // A paused sim, at its menu or end-of-flight screen, repeats its last values. Nothing is flying.
      if (sample.pauseFlags) return NONE
      if (sample.onGround ? sample.gsKts <= START_MOVING_KTS : sample.gsKts < START_AIRBORNE_KTS) return NONE
      this.begin(sample)
      started = true
    } else if (previous) {
      this.updateStats(previous, sample)
    }

    const flight = this.flight!
    this.updateLandingWindow(flight, sample)

    if (this.phase === 'ground') {
      if (!sample.onGround) {
        this.phase = 'air'
        this.airborneSince = sample.t
        this.parkedSince = null
      } else {
        const ended = this.checkParked(flight, sample)
        if (ended) return ended
      }
    } else if (this.phase === 'air') {
      if (sample.onGround) this.touchDown(flight, sample)
      else if (flight.takeoffAt === null && sample.t - this.airborneSince >= AIRBORNE_CONFIRM_MS) {
        flight.takeoffAt = this.airborneSince
      }
    }

    return { kind: 'sample', flight, started }
  }

  /** Call when the connection to the sim is lost. */
  interrupt(): LogbookFlight | null {
    if (!this.flight) return null
    const output = this.finish('interrupted', this.last?.t ?? this.flight.startedAt)
    return output.kind === 'finished' ? output.flight : null
  }

  private isJump(previous: TelemetrySample, sample: TelemetrySample): boolean {
    const distance = distanceNm(previous.lat, previous.lon, sample.lat, sample.lon)
    const seconds = Math.max(1, (sample.t - previous.t) / 1000)
    const speed = Math.max(previous.gsKts, sample.gsKts) * Math.max(1, sample.simRate)
    return distance > (speed / 3600) * seconds * JUMP_SPEED_FACTOR + JUMP_MARGIN_NM
  }

  private begin(sample: TelemetrySample): void {
    this.flight = {
      id: this.newId(),
      aircraft: null,
      status: 'in-progress',
      startedAt: sample.t,
      takeoffAt: null,
      landedAt: null,
      endedAt: null,
      origin: { lat: sample.lat, lon: sample.lon },
      destination: null,
      startedAirborne: !sample.onGround,
      distanceNm: 0,
      maxAltitudeFt: sample.altFt,
      maxG: sample.gForce,
      fuelStartGal: sample.fuelGal,
      fuelEndGal: sample.fuelGal,
      landings: [],
      events: []
    }
    this.phase = sample.onGround ? 'ground' : 'air'
    this.airborneSince = sample.t
    this.parkedSince = null
  }

  private updateStats(previous: TelemetrySample, sample: TelemetrySample): void {
    const flight = this.flight!
    flight.distanceNm += distanceNm(previous.lat, previous.lon, sample.lat, sample.lon)
    flight.maxAltitudeFt = Math.max(flight.maxAltitudeFt, sample.altFt)
    flight.maxG = Math.max(flight.maxG, sample.gForce)
    flight.fuelEndGal = sample.fuelGal

    const add = (type: FlightEvent['type'], value: number) => flight.events.push({ t: sample.t, type, value })
    if (sample.stall && !previous.stall) add('stall', 1)
    if (sample.overspeed && !previous.overspeed) add('overspeed', 1)
    if (sample.flaps !== previous.flaps) add('flaps', sample.flaps)
    if (sample.gearDown !== previous.gearDown) add('gear', sample.gearDown)
  }

  /** The sim updates touchdown speed just after contact, so keep reading it briefly. */
  private updateLandingWindow(flight: LogbookFlight, sample: TelemetrySample): void {
    const landing = flight.landings.at(-1)
    if (!landing || sample.t - landing.t > LANDING_WINDOW_MS) return
    landing.maxG = Math.max(landing.maxG, sample.gForce)
    landing.touchdownFpm = Math.abs(sample.touchdownFps) * 60
  }

  private touchDown(flight: LogbookFlight, sample: TelemetrySample): void {
    this.phase = 'ground'
    this.parkedSince = null
    const airborneMs = sample.t - this.airborneSince

    if (flight.takeoffAt === null && !flight.startedAirborne && airborneMs < AIRBORNE_CONFIRM_MS) return

    const previousLanding = flight.landings.at(-1)
    if (previousLanding && airborneMs < BOUNCE_MAX_MS) {
      previousLanding.bounces += 1
      return
    }

    const landing: LandingRecord = {
      t: sample.t,
      lat: sample.lat,
      lon: sample.lon,
      touchdownFpm: null,
      maxG: sample.gForce,
      iasKts: sample.iasKts,
      gsKts: sample.gsKts,
      ...windComponents(sample.windKts, sample.windDirTrue, sample.headingTrue),
      bounces: 0
    }
    flight.landings.push(landing)
    flight.landedAt = sample.t
    this.updateLandingWindow(flight, sample)
  }

  private checkParked(flight: LogbookFlight, sample: TelemetrySample): RecorderOutput | null {
    const hasFlown = flight.landings.length > 0
    const stopped = sample.gsKts < STOPPED_KTS
    // Ending the flight from the sim's menu leaves the engines running and the brake off, but the sim pauses itself.
    const simEndedIt = Boolean((sample.pauseFlags ?? 0) & SIM_PAUSED_ITSELF)
    // A held parking brake before takeoff may just be a hold short.
    const parked = stopped && (!enginesRunning(sample) || (hasFlown && (Boolean(sample.parkingBrake) || simEndedIt)))

    if (!parked) {
      this.parkedSince = null
      return null
    }
    this.parkedSince ??= sample.t
    if (sample.t - this.parkedSince < PARK_CONFIRM_MS) return null

    if (!hasFlown) {
      const flightId = flight.id
      this.reset()
      return { kind: 'discarded', flightId }
    }
    return this.finish('complete', sample.t)
  }

  private finish(status: LogbookFlight['status'], endedAt: number): RecorderOutput {
    const flight = this.flight!
    flight.status = status
    flight.endedAt = endedAt
    const end = this.last && hasPosition(this.last) && status === 'complete' ? this.last : null
    const landing = flight.landings.at(-1)
    if (end) flight.destination = { lat: end.lat, lon: end.lon }
    else if (landing) flight.destination = { lat: landing.lat, lon: landing.lon }
    this.reset()
    return { kind: 'finished', flight }
  }

  private reset(): void {
    this.flight = null
    this.phase = 'idle'
    this.parkedSince = null
  }
}
