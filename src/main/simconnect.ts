import { EventEmitter } from 'node:events'
import {
  EventFlag,
  InitPosition,
  open,
  Protocol,
  RawBuffer,
  SimConnectConstants,
  type SimConnectConnection,
  SimConnectDataType,
  SimConnectPeriod
} from 'node-simconnect'
import type { NumberRead, SavedPosition, SimPort } from '../core/restore'
import { TELEMETRY_FIELDS, type TelemetrySample } from '../shared/logbook'
import type { AircraftInfo, PositionMethod, SimStatus, StateValues, StateVar } from '../shared/types'

const RECONNECT_MS = 3000
const READ_TIMEOUT_MS = 4000
const HIGHEST_PRIORITY = 1
const USER = SimConnectConstants.OBJECT_ID_USER

type Pending = { readString: boolean; resolve: (value: number | string | null) => void }

export class SimConnection extends EventEmitter implements SimPort {
  private handle: SimConnectConnection | null = null
  private simName: string | null = null
  private retry: NodeJS.Timeout | null = null
  private stopped = false

  private nextId = 1
  private definitions = new Map<string, number>()
  private events = new Map<string, number>()
  private pending = new Map<number, Pending>()
  private sent = new Map<number, string>()
  private errors: string[] = []
  private initPositionDefinition: number | null = null
  private telemetryRequest: number | null = null
  private telemetryWarned = false
  private pauseEvent: number | null = null
  private pauseFlags = 0

  start(): void {
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.handle?.close()
  }

  get status(): SimStatus {
    return { connected: this.handle !== null, simName: this.simName }
  }

  private async connect(): Promise<void> {
    try {
      const { recvOpen, handle } = await open('Journeys', Protocol.KittyHawk)
      this.handle = handle
      this.simName = recvOpen.applicationName
      handle.on('simObjectData', (recv) => {
        if (recv.requestID === this.telemetryRequest) {
          this.handleTelemetry(recv.defineCount, recv.data)
          return
        }
        const entry = this.pending.get(recv.requestID)
        if (!entry) return
        this.pending.delete(recv.requestID)
        entry.resolve(entry.readString ? recv.data.readString256() : recv.data.readFloat64())
      })
      handle.on('exception', (recv) => {
        const context = this.sent.get(recv.sendId) ?? 'unknown request'
        this.errors.push(`${recv.exceptionName} on ${context}`)
      })
      handle.on('event', (recv) => {
        if (recv.clientEventId === this.pauseEvent) this.pauseFlags = recv.data
      })
      this.pauseEvent = this.nextId++
      this.track(handle.subscribeToSystemEvent(this.pauseEvent, 'Pause_EX1'), 'Pause_EX1 subscription')
      handle.on('quit', () => this.handleDisconnect())
      handle.on('close', () => this.handleDisconnect())
      handle.on('error', () => this.handleDisconnect())
      this.subscribeTelemetry(handle)
      this.emit('status', this.status)
    } catch {
      this.scheduleReconnect()
    }
  }

  private subscribeTelemetry(handle: SimConnectConnection): void {
    const definition = this.nextId++
    for (const [, simvar, unit] of TELEMETRY_FIELDS) {
      this.track(handle.addToDataDefinition(definition, simvar, unit, SimConnectDataType.FLOAT64), `telemetry ${simvar}`)
    }
    this.telemetryRequest = this.nextId++
    this.track(
      handle.requestDataOnSimObject(this.telemetryRequest, definition, USER, SimConnectPeriod.SECOND),
      'telemetry subscription'
    )
  }

  private handleTelemetry(defineCount: number, data: RawBuffer): void {
    // A rejected variable would shift every later field, so never decode a short record.
    if (defineCount !== TELEMETRY_FIELDS.length) {
      if (!this.telemetryWarned) {
        this.telemetryWarned = true
        console.error(`Telemetry ignored: expected ${TELEMETRY_FIELDS.length} fields, got ${defineCount}`, this.errors)
      }
      return
    }
    const sample = { t: Date.now() } as TelemetrySample
    for (const [key] of TELEMETRY_FIELDS) sample[key] = data.readFloat64()
    sample.pauseFlags = this.pauseFlags
    this.emit('telemetry', sample)
  }

  private handleDisconnect(): void {
    if (!this.handle) return
    this.handle = null
    this.simName = null
    // Ids are only valid for one connection.
    this.definitions.clear()
    this.events.clear()
    this.sent.clear()
    this.initPositionDefinition = null
    this.telemetryRequest = null
    this.pauseEvent = null
    this.pauseFlags = 0
    for (const entry of this.pending.values()) entry.resolve(null)
    this.pending.clear()
    this.emit('status', this.status)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.connect()
    }, RECONNECT_MS)
  }

  private requireHandle(): SimConnectConnection {
    if (!this.handle) throw new Error('Not connected to Microsoft Flight Simulator.')
    return this.handle
  }

  private track(sendId: number, context: string): void {
    this.sent.set(sendId, context)
  }

  private definitionFor(simvar: string, unit: string | null, type: SimConnectDataType): number {
    const key = `${simvar}|${unit}`
    const existing = this.definitions.get(key)
    if (existing !== undefined) return existing
    const id = this.nextId++
    this.track(this.requireHandle().addToDataDefinition(id, simvar, unit, type), simvar)
    this.definitions.set(key, id)
    return id
  }

  /** Each variable is requested on its own, so one the aircraft lacks can't sink the rest. */
  private read(simvar: string, unit: string | null, readString: boolean): Promise<number | string | null> {
    const handle = this.requireHandle()
    const type = readString ? SimConnectDataType.STRING256 : SimConnectDataType.FLOAT64
    const definition = this.definitionFor(simvar, unit, type)
    const request = this.nextId++
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request)
        resolve(null)
      }, READ_TIMEOUT_MS)
      this.pending.set(request, {
        readString,
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        }
      })
      this.track(handle.requestDataOnSimObject(request, definition, USER, SimConnectPeriod.ONCE), simvar)
    })
  }

  async readNumbers(vars: NumberRead[]): Promise<StateValues> {
    const results = await Promise.all(
      vars.map(async (v) => [v.id, (await this.read(v.simvar, v.unit, false)) as number | null] as const)
    )
    return Object.fromEntries(results)
  }

  async readAircraft(): Promise<AircraftInfo> {
    const [title, livery, atcId] = await Promise.all([
      this.read('TITLE', null, true),
      this.read('LIVERY NAME', null, true),
      this.read('ATC ID', null, true)
    ])
    return { title: String(title ?? 'Unknown'), livery: String(livery ?? ''), atcId: String(atcId ?? '') }
  }

  setNumber(variable: StateVar, value: number): void {
    this.writeNumber(variable.simvar, variable.unit, value)
  }

  private writeNumber(simvar: string, unit: string, value: number): void {
    const definition = this.definitionFor(simvar, unit, SimConnectDataType.FLOAT64)
    const buffer = new RawBuffer(8)
    buffer.writeFloat64(value)
    const sendId = this.requireHandle().setDataOnSimObject(definition, USER, { buffer, arrayCount: 0, tagged: false })
    this.track(sendId, `write ${simvar}`)
  }

  fireEvent(event: string, value = 0): void {
    const handle = this.requireHandle()
    let id = this.events.get(event)
    if (id === undefined) {
      id = this.nextId++
      this.track(handle.mapClientEventToSimEvent(id, event), `event ${event}`)
      this.events.set(event, id)
    }
    const sendId = handle.transmitClientEvent(USER, id, value, HIGHEST_PRIORITY, EventFlag.EVENT_FLAG_GROUPID_IS_PRIORITY)
    this.track(sendId, `event ${event}`)
  }

  setPosition(position: SavedPosition, method: PositionMethod): void {
    if (method === 'simvars') {
      this.writeNumber('PLANE LATITUDE', 'Degrees', position.latitude)
      this.writeNumber('PLANE LONGITUDE', 'Degrees', position.longitude)
      this.writeNumber('PLANE ALTITUDE', 'Feet', position.altitude)
      this.writeNumber('PLANE HEADING DEGREES TRUE', 'Degrees', position.heading)
      return
    }

    const handle = this.requireHandle()
    if (this.initPositionDefinition === null) {
      this.initPositionDefinition = this.nextId++
      this.track(
        handle.addToDataDefinition(this.initPositionDefinition, 'Initial Position', null, SimConnectDataType.INITPOSITION),
        'Initial Position'
      )
    }
    const init = new InitPosition()
    init.latitude = position.latitude
    init.longitude = position.longitude
    init.altitude = position.altitude
    init.heading = position.heading
    init.pitch = 0
    init.bank = 0
    init.onGround = true
    init.airspeed = 0
    this.track(handle.setDataOnSimObject(this.initPositionDefinition, USER, [init]), 'write Initial Position')
  }

  drainErrors(): string[] {
    const errors = this.errors
    this.errors = []
    return errors
  }
}
