import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_DESCENT, type DescentSettings } from '../shared/journey'
import type { TelemetrySample } from '../shared/logbook'
import { type DescentTarget, DescentWatcher, topOfDescent } from './descent'

// A field at sea level on the equator, so one degree of longitude is 60 nm.
const FIELD: DescentTarget = { ident: 'TEST', name: 'Test Field', lat: 0, lon: 0, elevationFt: 0 }
const ON: DescentSettings = { ...DEFAULT_DESCENT, pauseBeforeTod: true }

/** Level cruise at 9,500 ft and 120 kt, 60 nm west of the field. Fields the watcher doesn't read are left out. */
const at = (overrides: Partial<TelemetrySample>) =>
  ({ t: 0, lat: 0, lon: -1, altFt: 9500, aglFt: 9000, gsKts: 120, vsFpm: 0, onGround: 0, ...overrides }) as TelemetrySample

describe('topOfDescent', () => {
  it('starts down far enough out for a 3° path to the level-off height', () => {
    // 8,000 ft to lose at about 318 ft per nm is about 25 nm.
    const tod = topOfDescent(at({ lon: -1, altFt: 9500 }), FIELD, DEFAULT_DESCENT)
    expect(tod.toAltFt).toBe(1500)
    expect(tod.descentNm).toBeCloseTo(25.1, 0)
    expect(tod.distanceToTargetNm).toBeCloseTo(60, 0)
    expect(tod.minutesToTod).toBeCloseTo(17.4, 0)
  })

  it('uses the field elevation', () => {
    expect(topOfDescent(at({}), { ...FIELD, elevationFt: 5000 }, DEFAULT_DESCENT).toAltFt).toBe(6500)
  })
})

describe('DescentWatcher', () => {
  let watcher: DescentWatcher
  let t = 0
  beforeEach(() => {
    watcher = new DescentWatcher()
    t = 0
  })

  /** Flies east towards the field at 120 kt, one sample a second, until the watcher asks to pause. */
  function fly(seconds: number, overrides: Partial<TelemetrySample> = {}, settings = ON, target: DescentTarget | null = FIELD) {
    for (let i = 0; i < seconds; i++) {
      t += 1000
      const lon = -1 + (120 / 3600 / 60) * (t / 1000)
      const tod = watcher.ingest(at({ t, lon, ...overrides }), target, settings)
      if (tod) return { tod, seconds: t / 1000 }
    }
    return null
  }

  it('pauses about two minutes before top of descent, once', () => {
    const paused = fly(1200)!
    expect(paused.tod.minutesToTod).toBeLessThanOrEqual(2)
    expect(paused.tod.minutesToTod).toBeGreaterThan(1.9)
    expect(fly(600)).toBeNull()
  })

  it('does nothing with the setting off or no Journey stop ahead', () => {
    expect(fly(1200, {}, DEFAULT_DESCENT)).toBeNull()
    expect(fly(1200, {}, ON, null)).toBeNull()
  })

  it('does not pause while climbing or already descending', () => {
    expect(fly(1200, { vsFpm: 700 })).toBeNull()
    expect(fly(1200, { vsFpm: -500 })).toBeNull()
  })

  it('waits for the aircraft to settle into cruise', () => {
    // Already inside the window when levelling off: still waits 30 seconds before pausing.
    t = 980_000
    const paused = fly(60)!
    expect(paused.seconds - 980).toBeGreaterThanOrEqual(30)
  })

  it('does not pause for a tiny descent', () => {
    expect(fly(1800, { altFt: 1800 })).toBeNull()
  })

  it('pauses again on the next leg after landing', () => {
    expect(fly(1200)).not.toBeNull()
    watcher.ingest(at({ t: t + 1000, onGround: 1 }), FIELD, ON)
    t = 0
    expect(fly(1200)).not.toBeNull()
  })
})
