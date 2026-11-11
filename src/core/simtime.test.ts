import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCENT } from '../shared/journey'
import { airMinutes, blockMinutes, simSecondsBetween, type TelemetrySample } from '../shared/logbook'
import { BurnMeter } from './burn'
import { topOfDescent } from './descent'
import { FlightRecorder } from './recorder'

const base: TelemetrySample = {
  t: 1_000_000,
  lat: 38,
  lon: -121,
  altFt: 5000,
  aglFt: 4900,
  headingTrue: 0,
  pitch: 0,
  bank: 0,
  iasKts: 120,
  gsKts: 120,
  vsFpm: 0,
  onGround: 0,
  engine1: 1,
  engine2: 0,
  engine3: 0,
  engine4: 0,
  fuelGal: 50,
  gForce: 1,
  flaps: 0,
  gearDown: 0,
  parkingBrake: 0,
  stall: 0,
  overspeed: 0,
  windKts: 0,
  windDirTrue: 0,
  simRate: 1,
  touchdownFps: 0
}

/**
 * One real second per sample, the way telemetry arrives, at the given sim rate. The aircraft burns
 * 10 gal per sim hour and flies at 120 kt in sim time, so both move faster on the clock at higher rates.
 */
function cruise(realSeconds: number, simRate: number, from: TelemetrySample = base): TelemetrySample[] {
  const samples: TelemetrySample[] = []
  let s = from
  for (let i = 0; i < realSeconds; i++) {
    const sim = simRate
    s = { ...s, t: s.t + 1000, simRate, fuelGal: s.fuelGal - (10 / 3600) * sim, lat: s.lat + (120 / 3600 / 60) * sim }
    samples.push(s)
  }
  return samples
}

describe('simSecondsBetween', () => {
  it('scales real time by the sim rate', () => {
    expect(simSecondsBetween({ t: 0 }, { t: 1000, simRate: 1 })).toBe(1)
    expect(simSecondsBetween({ t: 0 }, { t: 1000, simRate: 4 })).toBe(4)
    expect(simSecondsBetween({ t: 0 }, { t: 1000, simRate: 0.5 })).toBe(0.5)
  })

  it('counts nothing while paused or across a long stall', () => {
    expect(simSecondsBetween({ t: 0 }, { t: 1000, simRate: 4, pauseFlags: 1 })).toBe(0)
    expect(simSecondsBetween({ t: 0 }, { t: 120_000, simRate: 1 })).toBe(0)
  })
})

describe('BurnMeter', () => {
  for (const rate of [1, 2, 4]) {
    it(`reads 10 gal per hour at ${rate}x`, () => {
      const meter = new BurnMeter()
      for (const s of cruise(180, rate)) meter.add(s)
      expect(meter.gallonsPerHour()).toBeCloseTo(10, 1)
    })
  }

  it('stays right when the rate changes part-way', () => {
    const meter = new BurnMeter()
    const first = cruise(90, 1)
    for (const s of first) meter.add(s)
    for (const s of cruise(20, 4, first.at(-1))) meter.add(s)
    expect(meter.gallonsPerHour()).toBeCloseTo(10, 1)
  })

  it('ignores time spent paused', () => {
    const meter = new BurnMeter()
    const flown = cruise(90, 1)
    for (const s of flown) meter.add(s)
    let last = flown.at(-1)!
    for (let i = 0; i < 300; i++) meter.add((last = { ...last, t: last.t + 1000, pauseFlags: 1 }))
    expect(meter.gallonsPerHour()).toBeCloseTo(10, 1)
  })

  it('starts over after refuelling', () => {
    const meter = new BurnMeter()
    const flown = cruise(90, 1)
    for (const s of flown) meter.add(s)
    meter.add({ ...flown.at(-1)!, t: flown.at(-1)!.t + 1000, fuelGal: 60 })
    expect(meter.gallonsPerHour()).toBeNull()
  })
})

describe('recorded flight times', () => {
  for (const rate of [1, 2, 4]) {
    it(`logs sim time at ${rate}x`, () => {
      const recorder = new FlightRecorder(() => 'f')
      let flight
      // 60 real seconds airborne.
      for (const s of [base, ...cruise(60, rate)]) {
        const out = recorder.ingest(s)
        if (out.kind === 'sample') flight = out.flight
      }
      expect(flight!.simSeconds).toBeCloseTo(60 * rate, 5)
      expect(flight!.airSimSeconds).toBeCloseTo(60 * rate, 5)
    })
  }
})

describe('airMinutes and blockMinutes', () => {
  const flight = { startedAt: 0, takeoffAt: 60_000, landedAt: 960_000, endedAt: 1_020_000 }

  it('prefer sim time', () => {
    expect(airMinutes({ ...flight, airSimSeconds: 3600 })).toBe(60)
    expect(blockMinutes({ ...flight, simSeconds: 4080 })).toBe(68)
  })

  it('fall back to the clock for older flights', () => {
    expect(airMinutes(flight)).toBe(15)
    expect(blockMinutes(flight)).toBe(17)
  })
})

describe('top of descent timing', () => {
  const sample = { ...base, lat: 0, lon: -1, altFt: 9500 }
  const field = { ident: 'TEST', name: 'Test', lat: 0, lon: 0, elevationFt: 0 }

  it('counts real minutes, so a faster sim rate brings it closer', () => {
    const at1 = topOfDescent({ ...sample, simRate: 1 }, field, DEFAULT_DESCENT).minutesToTod
    const at4 = topOfDescent({ ...sample, simRate: 4 }, field, DEFAULT_DESCENT).minutesToTod
    expect(at4).toBeCloseTo(at1 / 4, 5)
  })
})
