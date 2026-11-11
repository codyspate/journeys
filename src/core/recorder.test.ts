import { describe, expect, it } from 'vitest'
import type { LogbookFlight, TelemetrySample } from '../shared/logbook'
import { distanceNm, FlightRecorder, hasPosition, type RecorderOutput, windComponents } from './recorder'

const NM_PER_DEGREE_LAT = 60

class Sim {
  recorder = new FlightRecorder(() => `flight-${++this.ids}`)
  ids = 0
  outputs: RecorderOutput[] = []
  state: TelemetrySample = {
    t: 1_000_000,
    lat: 38,
    lon: -121,
    altFt: 100,
    aglFt: 0,
    headingTrue: 0,
    pitch: 0,
    bank: 0,
    iasKts: 0,
    gsKts: 0,
    vsFpm: 0,
    onGround: 1,
    engine1: 1,
    engine2: 0,
    engine3: 0,
    engine4: 0,
    fuelGal: 50,
    gForce: 1,
    flaps: 0,
    gearDown: 1,
    parkingBrake: 0,
    stall: 0,
    overspeed: 0,
    windKts: 0,
    windDirTrue: 0,
    simRate: 1,
    touchdownFps: 0
  }

  /** Advances one second per step, moving north at the current ground speed. */
  run(seconds: number, changes: Partial<TelemetrySample> = {}) {
    Object.assign(this.state, changes)
    for (let i = 0; i < seconds; i++) {
      this.state.t += 1000
      this.state.lat += ((this.state.gsKts * this.state.simRate) / 3600 / NM_PER_DEGREE_LAT)
      this.outputs.push(this.recorder.ingest({ ...this.state }))
    }
    return this
  }

  taxi() {
    return this.run(10, { gsKts: 10 })
  }
  takeOff() {
    return this.run(10, { gsKts: 100, iasKts: 100, onGround: 0, altFt: 1500 })
  }
  land(fps = 2) {
    return this.run(1, { onGround: 1, gsKts: 60, iasKts: 60, altFt: 100, touchdownFps: fps, gForce: 1.4 }).run(5, { gForce: 1 })
  }
  park() {
    return this.run(8, { gsKts: 0, iasKts: 0, parkingBrake: 1 })
  }

  finished(): LogbookFlight {
    const output = this.outputs.findLast((o) => o.kind === 'finished')
    if (output?.kind !== 'finished') throw new Error('no finished flight')
    return output.flight
  }
}

describe('a normal flight', () => {
  const sim = new Sim().taxi().takeOff().land(3).park()
  const flight = sim.finished()

  it('completes with the key times in order', () => {
    expect(flight.status).toBe('complete')
    expect(flight.startedAt).toBeLessThan(flight.takeoffAt!)
    expect(flight.takeoffAt!).toBeLessThan(flight.landedAt!)
    expect(flight.landedAt!).toBeLessThan(flight.endedAt!)
  })

  it('records the landing', () => {
    expect(flight.landings).toHaveLength(1)
    expect(flight.landings[0]).toMatchObject({ touchdownFpm: 180, maxG: 1.4, bounces: 0 })
  })

  it('tracks distance and altitude', () => {
    expect(flight.distanceNm).toBeGreaterThan(0)
    expect(flight.maxAltitudeFt).toBe(1500)
    expect(flight.destination).not.toBeNull()
  })
})

describe('flight boundaries', () => {
  it('stays idle while parked', () => {
    const sim = new Sim().run(30)
    expect(sim.outputs.every((o) => o.kind === 'none')).toBe(true)
  })

  it('discards a taxi that never flew', () => {
    const sim = new Sim().taxi().run(8, { gsKts: 0, engine1: 0 })
    expect(sim.outputs.at(-1)?.kind === 'discarded' || sim.outputs.some((o) => o.kind === 'discarded')).toBe(true)
  })

  it('does not treat a parking brake at the hold short as parked', () => {
    const sim = new Sim().taxi().run(20, { gsKts: 0, parkingBrake: 1 })
    expect(sim.outputs.some((o) => o.kind === 'discarded')).toBe(false)
  })

  it('ignores a brief lift-off while taxiing', () => {
    const sim = new Sim().taxi().run(1, { onGround: 0 }).run(3, { onGround: 1 }).run(1)
    const last = sim.outputs.at(-1)
    expect(last?.kind === 'sample' && last.flight.landings.length).toBe(0)
  })

  it('reports the start of a new flight once', () => {
    const sim = new Sim().taxi()
    expect(sim.outputs.filter((o) => o.kind === 'sample' && o.started)).toHaveLength(1)
  })

  it('ends the flight when the player ends it from the sim, brake off and engines running', () => {
    const sim = new Sim().taxi().takeOff().land().run(5, { gsKts: 0, iasKts: 0 })
    expect(sim.outputs.some((o) => o.kind === 'finished')).toBe(false)
    sim.run(6, { pauseFlags: 8 })
    expect(sim.finished().status).toBe('complete')
  })

  it("does not end the flight when the player pauses, or the sim pauses itself in the air", () => {
    const paused = new Sim().taxi().takeOff().land().run(20, { gsKts: 0, iasKts: 0, pauseFlags: 1 })
    expect(paused.outputs.some((o) => o.kind === 'finished')).toBe(false)
    const airborne = new Sim().taxi().takeOff().run(20, { pauseFlags: 8 })
    expect(airborne.outputs.some((o) => o.kind === 'finished')).toBe(false)
  })

  it('does not end a flight that never took off when the sim pauses itself', () => {
    const sim = new Sim().taxi().run(20, { gsKts: 0, pauseFlags: 8 })
    expect(sim.outputs.some((o) => o.kind === 'finished')).toBe(false)
  })

  it('starts recording mid-air if connected in flight', () => {
    const sim = new Sim().run(5, { onGround: 0, gsKts: 120, altFt: 5000 }).land().park()
    expect(sim.finished()).toMatchObject({ status: 'complete', startedAirborne: true })
  })
})

describe('landings', () => {
  it('counts a quick return to the ground as a bounce', () => {
    const sim = new Sim().taxi().takeOff().land().run(3, { onGround: 0 }).run(1, { onGround: 1 }).park()
    expect(sim.finished().landings).toHaveLength(1)
    expect(sim.finished().landings[0].bounces).toBe(1)
  })

  it('counts a touch and go as a second landing', () => {
    const sim = new Sim().taxi().takeOff().land().takeOff().land().park()
    expect(sim.finished().landings).toHaveLength(2)
  })

  it('splits wind into headwind and crosswind', () => {
    const direct = windComponents(20, 90, 0)
    expect(direct.crosswindKts).toBeCloseTo(20)
    expect(direct.headwindKts).toBeCloseTo(0)
    expect(windComponents(20, 0, 0).headwindKts).toBeCloseTo(20)
  })
})

describe('events', () => {
  it('logs each stall warning once, plus flap and gear changes', () => {
    const sim = new Sim().taxi().takeOff()
    sim.run(3, { stall: 1 }).run(2, { stall: 0 }).run(1, { flaps: 2 }).run(1, { gearDown: 0 })
    sim.land().park()
    const types = sim.finished().events.map((e) => e.type)
    expect(types.filter((t) => t === 'stall')).toHaveLength(1)
    expect(types).toContain('flaps')
    expect(types).toContain('gear')
  })
})

describe('discontinuities', () => {
  it('ends the flight when the aircraft jumps across the map', () => {
    const sim = new Sim().taxi().takeOff()
    sim.state.lat = 50
    sim.run(1)
    expect(sim.finished().status).toBe('ended-early')
  })

  it('does not treat sim rate as a jump', () => {
    const sim = new Sim().taxi().takeOff().run(30, { gsKts: 450, simRate: 16 })
    expect(sim.outputs.some((o) => o.kind === 'finished')).toBe(false)
  })

  it('ends the flight when returning to the main menu', () => {
    const sim = new Sim().taxi().takeOff()
    const airborneUntil = sim.state.t
    sim.state.lat = 0
    sim.state.lon = 0
    sim.run(25)
    expect(sim.finished()).toMatchObject({ status: 'ended-early', endedAt: airborneUntil })
  })

  it('does not start a flight from the main menu position', () => {
    const sim = new Sim()
    sim.state.lat = 0
    sim.state.lon = 0
    sim.run(5, { onGround: 0 })
    expect(sim.outputs.every((o) => o.kind === 'none')).toBe(true)
  })

  it('ignores the sim loading a flight, which reports near 0,0 at high altitude', () => {
    const sim = new Sim()
    sim.state.lat = 0.00002
    sim.state.lon = 0.00001
    sim.run(45, { onGround: 0, altFt: 53820, aglFt: 53803, gForce: 0 })
    expect(sim.outputs.every((o) => o.kind === 'none')).toBe(true)
  })

  it('does not start a flight for a stationary aircraft reported off the ground', () => {
    const sim = new Sim().run(10, { onGround: 0, gsKts: 0 })
    expect(sim.outputs.every((o) => o.kind === 'none')).toBe(true)
  })

  it('marks a lost connection as interrupted', () => {
    const sim = new Sim().taxi().takeOff()
    expect(sim.recorder.interrupt()?.status).toBe('interrupted')
    expect(sim.recorder.interrupt()).toBeNull()
  })
})

describe('distanceNm', () => {
  it('is about 60 NM per degree of latitude', () => {
    expect(distanceNm(10, 20, 11, 20)).toBeCloseTo(60, 0)
  })
})

describe('placeholder positions', () => {
  it("ignores where the sim parks the aircraft while loading or in a menu", () => {
    expect(hasPosition({ lat: 0, lon: 0 })).toBe(false)
    expect(hasPosition({ lat: -2e-7, lon: 90.0003 })).toBe(false)
    expect(hasPosition({ lat: 0.001, lon: -90 })).toBe(false)
    expect(hasPosition({ lat: 38.49, lon: -121.1 })).toBe(true)
    expect(hasPosition({ lat: 0.5, lon: 90 })).toBe(true)
  })

  it('does not start a flight from a menu position', () => {
    const sim = new Sim().run(20, { lat: 0, lon: 90, onGround: 0, gsKts: 0, altFt: 54000 })
    expect(sim.outputs.every((o) => o.kind === 'none')).toBe(true)
  })
})

describe('pausing mid-flight', () => {
  it('keeps the flight open through a frozen pause', () => {
    const sim = new Sim().taxi().takeOff().run(120, { gsKts: 100, pauseFlags: 8 })
    expect(sim.outputs.some((o) => o.kind === 'finished')).toBe(false)
  })

  it('does not treat a menu placeholder position as a teleport', () => {
    const sim = new Sim().taxi().takeOff()
    const before = { lat: sim.state.lat, lon: sim.state.lon }
    sim.run(10, { lat: 0, lon: 90, pauseFlags: 8 })
    Object.assign(sim.state, before, { pauseFlags: 0 })
    sim.run(5)
    expect(sim.outputs.some((o) => o.kind === 'finished')).toBe(false)
    sim.land().park()
    expect(sim.finished().status).toBe('complete')
  })

  it('still notices a real load somewhere else afterwards', () => {
    const sim = new Sim().taxi().takeOff()
    sim.run(5, { lat: 0, lon: 90 })
    Object.assign(sim.state, { lat: 47.45, lon: -122.31 })
    sim.run(2)
    expect(sim.finished().status).toBe('ended-early')
  })
})

describe('a paused sim', () => {
  it('never starts a flight from the frozen values it repeats at its menu', () => {
    const sim = new Sim().run(30, { onGround: 0, gsKts: 144, altFt: 11759, pauseFlags: 8 })
    expect(sim.outputs.every((o) => o.kind === 'none')).toBe(true)
  })

  it('starts recording once the sim is running again', () => {
    const sim = new Sim().run(5, { onGround: 0, gsKts: 144, altFt: 11759, pauseFlags: 8 }).run(3, { pauseFlags: 0 })
    expect(sim.outputs.some((o) => o.kind === 'sample' && o.started)).toBe(true)
  })
})
