import { catalogFor, profileById, profileForTitle } from '../shared/catalog'
import type {
  AircraftInfo,
  PositionMethod,
  ReportRow,
  RestoreOptions,
  RestoreReport,
  Snapshot,
  StateValues,
  StateVar
} from '../shared/types'

export interface SavedPosition {
  latitude: number
  longitude: number
  altitude: number
  heading: number
}

export type NumberRead = Pick<StateVar, 'id' | 'simvar' | 'unit'>

/** Everything the restore logic needs from the sim. Faked in tests. */
export interface SimPort {
  readNumbers(vars: NumberRead[]): Promise<StateValues>
  readAircraft(): Promise<AircraftInfo>
  setNumber(variable: StateVar, value: number): void
  fireEvent(event: string, value?: number): void
  setPosition(position: SavedPosition, method: PositionMethod): void
  /** Returns and clears errors the sim reported since the last call. */
  drainErrors(): string[]
}

export type RestoreStep =
  | { action: 'set'; variable: StateVar; value: number }
  | { action: 'event'; variable: StateVar; event: string; value?: number }

const ENGINE_COUNT: NumberRead = { id: 'engineCount', simvar: 'NUMBER OF ENGINES', unit: 'Number' }
const ON_GROUND: NumberRead = { id: 'onGround', simvar: 'SIM ON GROUND', unit: 'Bool' }
const GROUND_SPEED: NumberRead = { id: 'groundSpeed', simvar: 'GROUND VELOCITY', unit: 'Knots' }

const PARKED_MAX_KNOTS = 1

export function matches(variable: StateVar, target: number, actual: number): boolean {
  let difference = Math.abs(target - actual)
  if (variable.angular) difference = Math.min(difference, 360 - (difference % 360))
  return difference <= variable.tolerance + Number.EPSILON
}

function appliesToAircraft(variable: StateVar, engineCount: number): boolean {
  return variable.engine === undefined || variable.engine <= engineCount
}

export function buildRestorePlan(
  catalog: StateVar[],
  target: StateValues,
  current: StateValues,
  categories: string[],
  engineCount: number
): RestoreStep[] {
  const steps: RestoreStep[] = []
  const ordered = [...catalog].sort((a, b) => a.phase - b.phase)

  for (const variable of ordered) {
    if (variable.restore.kind === 'position') continue
    if (!categories.includes(variable.category)) continue
    if (!appliesToAircraft(variable, engineCount)) continue

    const wanted = target[variable.id]
    const now = current[variable.id]
    if (wanted == null || now == null) continue

    if (variable.restore.kind === 'toggle') {
      if (Boolean(wanted) !== Boolean(now)) {
        steps.push({ action: 'event', variable, event: variable.restore.event, value: variable.restore.value })
      }
    } else if (!matches(variable, wanted, now)) {
      if (variable.restore.kind === 'set') {
        steps.push({ action: 'set', variable, value: wanted })
      } else {
        steps.push({ action: 'event', variable, event: variable.restore.event, value: wanted })
      }
    }
  }
  return steps
}

export function compareState(
  catalog: StateVar[],
  target: StateValues,
  actual: StateValues,
  categories: string[],
  engineCount: number
): ReportRow[] {
  return catalog
    .filter((variable) => appliesToAircraft(variable, engineCount))
    .map((variable) => {
      const wanted = target[variable.id] ?? null
      const got = actual[variable.id] ?? null
      const base = {
        id: variable.id,
        label: variable.label,
        category: variable.category,
        target: wanted,
        actual: got
      }
      if (!categories.includes(variable.category)) return { ...base, status: 'skipped' as const }
      if (wanted === null || got === null) return { ...base, status: 'unavailable' as const }
      return { ...base, status: matches(variable, wanted, got) ? ('restored' as const) : ('mismatch' as const) }
    })
}

export async function captureSnapshot(port: SimPort, name: string, now: Date, id: string): Promise<Snapshot> {
  const aircraft = await port.readAircraft()
  const profile = profileForTitle(aircraft.title)
  const context = await port.readNumbers([ENGINE_COUNT, ON_GROUND, GROUND_SPEED])
  const values = await port.readNumbers(catalogFor(profile))

  return {
    id,
    name,
    capturedAt: now.toISOString(),
    aircraft,
    profileId: profile.id,
    engineCount: context.engineCount ?? 1,
    parked: context.onGround === 1 && (context.groundSpeed ?? 0) <= PARKED_MAX_KNOTS,
    values
  }
}

export interface RestoreTiming {
  wait(ms: number): Promise<void>
  positionSettleMs: number
  stepDelayMs: number
  finalSettleMs: number
}

export const DEFAULT_TIMING: RestoreTiming = {
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  positionSettleMs: 3000,
  stepDelayMs: 150,
  finalSettleMs: 1500
}

function savedPosition(values: StateValues): SavedPosition | null {
  const latitude = values['position.latitude']
  const longitude = values['position.longitude']
  const altitude = values['position.altitude']
  const heading = values['position.heading']
  if (latitude == null || longitude == null || altitude == null || heading == null) return null
  return { latitude, longitude, altitude, heading }
}

export async function restoreSnapshot(
  port: SimPort,
  snapshot: Snapshot,
  options: RestoreOptions,
  timing: RestoreTiming = DEFAULT_TIMING,
  clock: () => number = Date.now
): Promise<RestoreReport> {
  const startedAt = clock()
  const warnings: string[] = []
  const catalog = catalogFor(profileById(snapshot.profileId))
  port.drainErrors()

  const aircraft = await port.readAircraft()
  if (aircraft.title !== snapshot.aircraft.title) {
    warnings.push(`Saved on "${snapshot.aircraft.title}" but restoring onto "${aircraft.title}".`)
  }
  if (!snapshot.parked) warnings.push('This snapshot was not captured while parked.')

  let positionMethod: PositionMethod | null = null
  if (options.categories.includes('position')) {
    const position = savedPosition(snapshot.values)
    if (position) {
      port.setPosition(position, options.positionMethod)
      positionMethod = options.positionMethod
      await timing.wait(timing.positionSettleMs)
    } else {
      warnings.push('Position could not be restored because it was incomplete in the snapshot.')
    }
  }

  const current = await port.readNumbers(catalog)
  const steps = buildRestorePlan(catalog, snapshot.values, current, options.categories, snapshot.engineCount)

  for (const step of steps) {
    if (step.action === 'set') port.setNumber(step.variable, step.value)
    else port.fireEvent(step.event, step.value)
    await timing.wait(timing.stepDelayMs)
  }
  await timing.wait(timing.finalSettleMs)

  const actual = await port.readNumbers(catalog)
  const rows = compareState(catalog, snapshot.values, actual, options.categories, snapshot.engineCount)
  warnings.push(...port.drainErrors())

  return { positionMethod, durationMs: clock() - startedAt, rows, warnings }
}
