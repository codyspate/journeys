import { describe, expect, it } from 'vitest'
import { BASE_CATALOG, catalogFor, DEFAULT_PROFILE, profileForTitle } from '../shared/catalog'
import type { AircraftInfo, PositionMethod, RestoreOptions, Snapshot, StateValues, StateVar } from '../shared/types'
import {
  buildRestorePlan,
  captureSnapshot,
  compareState,
  matches,
  type NumberRead,
  restoreSnapshot,
  type RestoreTiming,
  type SavedPosition,
  type SimPort
} from './restore'

const ALL = ['position', 'fuel', 'controls', 'electrical', 'lights', 'custom']
const variable = (id: string): StateVar => BASE_CATALOG.find((v) => v.id === id)!
const noWait: RestoreTiming = { wait: async () => {}, positionSettleMs: 0, stepDelayMs: 0, finalSettleMs: 0 }

class FakeSim implements SimPort {
  aircraft: AircraftInfo = { title: 'Cessna 172', livery: 'Stock', atcId: 'N172' }
  values: StateValues = { engineCount: 1, onGround: 1, groundSpeed: 0 }
  log: string[] = []
  positions: { position: SavedPosition; method: PositionMethod }[] = []
  errors: string[] = []
  /** Events that the fake aircraft ignores, like a switch with custom logic. */
  deadEvents = new Set<string>()

  async readNumbers(vars: NumberRead[]) {
    return Object.fromEntries(vars.map((v) => [v.id, this.values[v.id] ?? null]))
  }
  async readAircraft() {
    return this.aircraft
  }
  setNumber(v: StateVar, value: number) {
    this.log.push(`set:${v.id}`)
    this.values[v.id] = value
  }
  fireEvent(event: string, value?: number) {
    this.log.push(`event:${event}`)
    if (this.deadEvents.has(event)) return
    const target = BASE_CATALOG.find(
      (v) => 'event' in v.restore && v.restore.event === event && (v.restore.kind !== 'toggle' || v.restore.value === value)
    )!
    this.values[target.id] = target.restore.kind === 'toggle' ? (this.values[target.id] ? 0 : 1) : value!
  }
  setPosition(position: SavedPosition, method: PositionMethod) {
    this.log.push('position')
    this.positions.push({ position, method })
    this.values['position.latitude'] = position.latitude
    this.values['position.longitude'] = position.longitude
    this.values['position.altitude'] = position.altitude
    this.values['position.heading'] = position.heading
  }
  drainErrors() {
    const errors = this.errors
    this.errors = []
    return errors
  }
}

function snapshot(values: StateValues, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 's1',
    name: 'test',
    capturedAt: '2026-11-09T00:00:00.000Z',
    aircraft: { title: 'Cessna 172', livery: 'Stock', atcId: 'N172' },
    profileId: 'default',
    engineCount: 1,
    parked: true,
    values,
    ...overrides
  }
}

const options = (categories = ALL): RestoreOptions => ({
  categories: categories as RestoreOptions['categories'],
  positionMethod: 'initposition'
})

describe('matches', () => {
  it('treats headings either side of north as close', () => {
    expect(matches(variable('position.heading'), 359, 1)).toBe(true)
    expect(matches(variable('position.heading'), 350, 10)).toBe(false)
  })
})

describe('buildRestorePlan', () => {
  it('only toggles switches that differ', () => {
    const steps = buildRestorePlan(
      BASE_CATALOG,
      { 'electrical.battery1': 1, 'lights.beacon': 0 },
      { 'electrical.battery1': 0, 'lights.beacon': 0 },
      ALL,
      1
    )
    expect(steps.map((s) => s.variable.id)).toEqual(['electrical.battery1'])
  })

  it('restores fuel, then controls, then power, then powered systems, then lights', () => {
    const target = { 'lights.beacon': 1, 'electrical.avionics': 1, 'electrical.battery1': 1, 'controls.parkingBrake': 1, 'fuel.leftMain': 20 }
    const current = { 'lights.beacon': 0, 'electrical.avionics': 0, 'electrical.battery1': 0, 'controls.parkingBrake': 0, 'fuel.leftMain': 5 }
    const steps = buildRestorePlan(BASE_CATALOG, target, current, ALL, 1)
    expect(steps.map((s) => s.variable.id)).toEqual([
      'fuel.leftMain',
      'controls.parkingBrake',
      'electrical.battery1',
      'electrical.avionics',
      'lights.beacon'
    ])
  })

  it('toggles each battery by its own index', () => {
    const [step] = buildRestorePlan(
      BASE_CATALOG,
      { 'electrical.battery1': 1, 'electrical.battery2': 0 },
      { 'electrical.battery1': 1, 'electrical.battery2': 1 },
      ALL,
      1
    )
    expect(step).toMatchObject({ action: 'event', event: 'TOGGLE_MASTER_BATTERY', value: 2 })
  })

  it('leaves values alone when within tolerance', () => {
    expect(buildRestorePlan(BASE_CATALOG, { 'fuel.leftMain': 20 }, { 'fuel.leftMain': 20.1 }, ALL, 1)).toEqual([])
  })

  it('ignores engines the aircraft does not have', () => {
    const steps = buildRestorePlan(BASE_CATALOG, { 'electrical.alternator2': 1 }, { 'electrical.alternator2': 0 }, ALL, 1)
    expect(steps).toEqual([])
  })

  it('does not act when a current value could not be read', () => {
    expect(buildRestorePlan(BASE_CATALOG, { 'electrical.battery1': 1 }, { 'electrical.battery1': null }, ALL, 1)).toEqual([])
  })

  it('sends the saved value with value events', () => {
    const [step] = buildRestorePlan(BASE_CATALOG, { 'fuel.selector1': 2 }, { 'fuel.selector1': 1 }, ALL, 1)
    expect(step).toMatchObject({ action: 'event', event: 'FUEL_SELECTOR_SET', value: 2 })
  })
})

describe('compareState', () => {
  it('marks unselected categories as skipped', () => {
    const rows = compareState(BASE_CATALOG, { 'electrical.battery1': 1 }, { 'electrical.battery1': 0 }, ['position'], 1)
    expect(rows.find((r) => r.id === 'electrical.battery1')?.status).toBe('skipped')
  })
})

describe('captureSnapshot', () => {
  it('flags a moving aircraft as not parked', async () => {
    const sim = new FakeSim()
    sim.values.groundSpeed = 30
    const result = await captureSnapshot(sim, 'x', new Date(0), 'id')
    expect(result.parked).toBe(false)
  })

  it('applies the Comanche profile from the aircraft title', async () => {
    const sim = new FakeSim()
    sim.aircraft = { ...sim.aircraft, title: 'A2A Simulations Comanche 250' }
    const result = await captureSnapshot(sim, 'x', new Date(0), 'id')
    expect(result.profileId).toBe('a2a-comanche')
    expect(profileForTitle('A2A Simulations Comanche 250').restore).toEqual(DEFAULT_PROFILE.restore)
  })
})

describe('restoreSnapshot', () => {
  const saved = {
    'position.latitude': 32.7,
    'position.longitude': -117.2,
    'position.altitude': 17,
    'position.heading': 270,
    'fuel.leftMain': 18,
    'electrical.battery1': 1,
    'lights.beacon': 1
  }

  it('moves the aircraft first and reports what was restored', async () => {
    const sim = new FakeSim()
    Object.assign(sim.values, { 'fuel.leftMain': 30, 'electrical.battery1': 0, 'lights.beacon': 0 })
    const report = await restoreSnapshot(sim, snapshot(saved), options(), noWait)

    expect(sim.log[0]).toBe('position')
    expect(report.positionMethod).toBe('initposition')
    for (const id of Object.keys(saved)) {
      expect(report.rows.find((r) => r.id === id)?.status).toBe('restored')
    }
  })

  it('reports a switch the aircraft refused to change', async () => {
    const sim = new FakeSim()
    sim.deadEvents.add('TOGGLE_MASTER_BATTERY')
    Object.assign(sim.values, { 'fuel.leftMain': 18, 'electrical.battery1': 0, 'lights.beacon': 1 })
    const report = await restoreSnapshot(sim, snapshot(saved), options(), noWait)
    expect(report.rows.find((r) => r.id === 'electrical.battery1')?.status).toBe('mismatch')
  })

  it('touches nothing outside the chosen categories', async () => {
    const sim = new FakeSim()
    Object.assign(sim.values, { 'fuel.leftMain': 30, 'electrical.battery1': 0 })
    await restoreSnapshot(sim, snapshot(saved), options(['position']), noWait)
    expect(sim.log).toEqual(['position'])
    expect(sim.values['fuel.leftMain']).toBe(30)
  })

  it('warns but continues on a different aircraft', async () => {
    const sim = new FakeSim()
    sim.aircraft = { ...sim.aircraft, title: 'Boeing 737' }
    sim.values['fuel.leftMain'] = 30
    const report = await restoreSnapshot(sim, snapshot(saved), options(['fuel']), noWait)
    expect(report.warnings[0]).toContain('Boeing 737')
    expect(sim.log).toContain('set:fuel.leftMain')
  })

  it('includes errors reported by the sim', async () => {
    const sim = new FakeSim()
    const port: SimPort = Object.assign(sim, {
      drainErrors: (() => {
        let calls = 0
        return () => (++calls === 2 ? ['UNRECOGNIZED_ID on PLANE X'] : [])
      })()
    })
    const report = await restoreSnapshot(port, snapshot(saved), options(['fuel']), noWait)
    expect(report.warnings).toContain('UNRECOGNIZED_ID on PLANE X')
  })
})

describe('profiles', () => {
  it('adds profile L:vars as custom variables', () => {
    const catalog = catalogFor({ ...DEFAULT_PROFILE, lvars: [{ name: 'XMLVAR_Test', label: 'Test' }] })
    expect(catalog.find((v) => v.id === 'custom.XMLVAR_Test')).toMatchObject({ simvar: 'L:XMLVAR_Test', category: 'custom' })
  })
})
