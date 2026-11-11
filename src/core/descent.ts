import type { DescentSettings, TopOfDescent } from '../shared/journey'
import type { TelemetrySample } from '../shared/logbook'
import { distanceNm } from './recorder'

const FEET_PER_NM = 6076.12
/** Level enough to count as cruising. */
const LEVEL_FPM = 300
const LEVEL_FOR_MS = 30_000
const MIN_GS_KTS = 40
/** Not worth pausing for a descent smaller than this. */
const MIN_DESCENT_FT = 500

export interface DescentTarget {
  ident: string
  name: string
  lat: number
  lon: number
  elevationFt: number
}

/** Where descent should start for the target, from the aircraft's current altitude and groundspeed. */
export function topOfDescent(sample: TelemetrySample, target: DescentTarget, settings: DescentSettings): TopOfDescent {
  const toAltFt = target.elevationFt + settings.arriveAboveFieldFt
  const feetPerNm = Math.tan((settings.angleDeg * Math.PI) / 180) * FEET_PER_NM
  const descentNm = Math.max(0, sample.altFt - toAltFt) / feetPerNm
  const distanceToTargetNm = distanceNm(sample.lat, sample.lon, target.lat, target.lon)
  const distanceToTodNm = distanceToTargetNm - descentNm
  return {
    ident: target.ident,
    name: target.name,
    distanceToTargetNm,
    descentNm,
    distanceToTodNm,
    minutesToTod: sample.gsKts > 0 ? (distanceToTodNm / sample.gsKts) * 60 : Infinity,
    fromAltFt: sample.altFt,
    toAltFt
  }
}

/** Watches a flight and says when to pause, once per leg, a little before top of descent. */
export class DescentWatcher {
  private levelSince: number | null = null
  private pausedFor: string | null = null

  ingest(sample: TelemetrySample, target: DescentTarget | null, settings: DescentSettings | null): TopOfDescent | null {
    if (sample.onGround) {
      this.levelSince = null
      this.pausedFor = null
      return null
    }
    this.levelSince = Math.abs(sample.vsFpm) < LEVEL_FPM ? (this.levelSince ?? sample.t) : null

    if (!target || !settings?.pauseBeforeTod || this.pausedFor === target.ident) return null
    if (sample.gsKts < MIN_GS_KTS || this.levelSince === null || sample.t - this.levelSince < LEVEL_FOR_MS) return null

    const tod = topOfDescent(sample, target, settings)
    if (sample.altFt - tod.toAltFt < MIN_DESCENT_FT) return null
    if (tod.minutesToTod <= 0 || tod.minutesToTod > settings.minutesBefore) return null
    this.pausedFor = target.ident
    return tod
  }
}
